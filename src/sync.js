import express from 'express';
import crypto from 'crypto';
import { getStoredAuthClient } from './auth.js';
import { notifySyncFailure, notifySyncRecovered, notifyAccountDisconnected } from './notify.js';
import { 
  getSyncConfig, 
  saveSyncConfig, 
  saveSyncedEvent, 
  getSyncedEvent,
  getSyncedEventByTargetId,
  deleteSyncedEvent,
  getAllSyncedEvents,
  getSyncedEventsByAccount,
  getSyncedEventsByAccountAndTarget,
  updateLastSync,
  addSyncLog,
  getSyncLogs,
  getTokens,
  savePendingDuplicate,
  getPendingDuplicates,
  getPendingDuplicate,
  updatePendingDuplicateStatus,
  deletePendingDuplicate,
  isPendingDuplicate,
  getCalendars,
  getEnabledCalendars,
  getCalendarsByAccount,
  getCalendarById,
  saveCalendar,
  updateCalendar,
  removeCalendar,
  getIcsToken,
  saveSyncEnabled
} from './database.js';
import { 
  getEventsForSync, 
  createEvent, 
  updateEvent, 
  deleteEvent,
  getEvent 
} from './calendar.js';

export const syncRouter = express.Router();

// Sync marker to identify synced events (hidden in description)
const SYNC_MARKER_PREFIX = '<!-- CalSync:';
const SYNC_MARKER_SUFFIX = ' -->';

// Create a hash of event data for change detection
function createEventHash(event) {
  const data = {
    summary: event.summary || '',
    description: stripSyncMarker(event.description || ''),
    start: event.start,
    end: event.end,
    location: event.location || '',
    attendees: event.attendees?.map(a => a.email).sort() || []
  };
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}

// Add sync marker to description
function addSyncMarker(description, sourceEventId, sourceAccount) {
  const marker = `${SYNC_MARKER_PREFIX}${sourceAccount}:${sourceEventId}${SYNC_MARKER_SUFFIX}`;
  return description ? `${description}\n\n${marker}` : marker;
}

// Extract sync marker from description
function extractSyncMarker(description) {
  if (!description) return null;
  
  const regex = new RegExp(`${SYNC_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+):([^\\s]+)${SYNC_MARKER_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  const match = description.match(regex);
  
  if (match) {
    return {
      sourceAccount: parseInt(match[1]),
      sourceEventId: match[2]
    };
  }
  return null;
}

// Strip sync marker from description
function stripSyncMarker(description) {
  if (!description) return '';
  
  const regex = new RegExp(`\\n*${SYNC_MARKER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\d+:[^\\s]+${SYNC_MARKER_SUFFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  return description.replace(regex, '').trim();
}

// Strip all known prefixes from a title
function stripAllPrefixes(title, allPrefixes) {
  if (!title) return '';
  let result = title;
  for (const prefix of allPrefixes) {
    if (prefix && result.toUpperCase().startsWith(prefix.toUpperCase())) {
      result = result.substring(prefix.length);
      break;
    }
  }
  // Strip any remaining bracket prefixes like [HOLD], [PENDING], etc.
  result = result.replace(/^\[[^\]]+\]\s*/g, '');
  return result.trim();
}

// Strip known suffixes from a title  
function stripAllSuffixes(title, allSuffixes) {
  if (!title) return title;
  let result = title;
  for (const suffix of allSuffixes) {
    if (suffix && result.toUpperCase().endsWith(suffix.toUpperCase())) {
      result = result.substring(0, result.length - suffix.length);
      break;
    }
  }
  return result.trim();
}

// Get all known prefixes/suffixes from calendar configurations
function getAllAffixes(calendars) {
  const prefixes = calendars.map(c => c.prefix).filter(p => p && p.trim());
  const suffixes = calendars.map(c => c.suffix).filter(s => s && s.trim());
  return { prefixes, suffixes };
}

// Strip title to its "original" form (no prefixes/suffixes)
function getOriginalTitle(title, calendars) {
  const { prefixes, suffixes } = getAllAffixes(calendars);
  let result = stripAllPrefixes(title, prefixes);
  result = stripAllSuffixes(result, suffixes);
  return result;
}

// Check for TRUE duplicate: the exact synced version already exists in target calendar
function findExistingDuplicate(event, sourceCal, existingEvents, allCalendars) {
  const eventStart = event.start?.dateTime || event.start?.date;
  const originalTitle = getOriginalTitle(event.summary || '', allCalendars);
  const syncedTitle = `${sourceCal.prefix || ''}${originalTitle}${sourceCal.suffix || ''}`;
  
  for (const existing of existingEvents) {
    const existingStart = existing.start?.dateTime || existing.start?.date;
    
    if (eventStart === existingStart && 
        existing.summary?.toLowerCase() === syncedTitle.toLowerCase()) {
      return existing;
    }
  }
  
  return null;
}

// Check for duplicates WITHIN a calendar
function findDuplicatesInCalendar(events, allCalendars) {
  const duplicates = [];
  const exactMatches = new Map();
  const { prefixes, suffixes } = getAllAffixes(allCalendars);
  
  // Sort: prioritize events WITHOUT any prefix (originals first)
  const sortByOriginalFirst = (a, b) => {
    const aSummary = (a.summary || '').toUpperCase();
    const bSummary = (b.summary || '').toUpperCase();
    const aHasPrefix = prefixes.some(p => aSummary.startsWith(p.toUpperCase()));
    const bHasPrefix = prefixes.some(p => bSummary.startsWith(p.toUpperCase()));
    if (aHasPrefix && !bHasPrefix) return 1;
    if (!aHasPrefix && bHasPrefix) return -1;
    return 0;
  };
  
  const groupedEventIds = new Set();
  
  // Find events with multiple prefixes (corrupted)
  const corruptedEvents = [];
  for (const event of events) {
    if (event.status === 'cancelled') continue;
    const upper = (event.summary || '').toUpperCase();
    const matchingPrefixes = prefixes.filter(p => upper.includes(p.toUpperCase()));
    if (matchingPrefixes.length >= 2) {
      corruptedEvents.push(event);
      groupedEventIds.add(event.id);
    }
  }
  
  if (corruptedEvents.length > 0) {
    duplicates.push({
      type: 'corrupted',
      key: 'corrupted-multiple-prefixes',
      title: 'Corrupted: Has multiple prefixes',
      time: 'Various',
      events: corruptedEvents,
      count: corruptedEvents.length,
      deleteAll: true
    });
  }
  
  // Collect events for grouping
  for (const event of events) {
    if (event.status === 'cancelled') continue;
    if (groupedEventIds.has(event.id)) continue;
    
    const startDateTime = event.start?.dateTime || event.start?.date || '';
    const title = (event.summary || '').toLowerCase();
    const exactKey = `${title}|${startDateTime}`;
    
    if (!exactMatches.has(exactKey)) {
      exactMatches.set(exactKey, []);
    }
    exactMatches.get(exactKey).push(event);
  }
  
  // Find exact duplicates (same title, same time)
  for (const [key, eventGroup] of exactMatches) {
    if (eventGroup.length > 1) {
      const ungrouped = eventGroup.filter(e => !groupedEventIds.has(e.id));
      if (ungrouped.length < 2) continue;
      
      ungrouped.sort(sortByOriginalFirst);
      duplicates.push({
        type: 'exact',
        key,
        title: ungrouped[0].summary,
        time: ungrouped[0].start?.dateTime || ungrouped[0].start?.date,
        events: ungrouped,
        count: ungrouped.length
      });
      ungrouped.forEach(e => groupedEventIds.add(e.id));
    }
  }
  
  // Find similar events on same day (fuzzy match)
  const eventsByDay = new Map();
  for (const event of events) {
    if (event.status === 'cancelled' || groupedEventIds.has(event.id)) continue;
    const startDateTime = event.start?.dateTime || event.start?.date || '';
    const startDate = startDateTime.split('T')[0];
    const hasPfx = prefixes.some(p => (event.summary || '').toUpperCase().startsWith(p.toUpperCase()));
    if (hasPfx) {
      if (!eventsByDay.has(startDate)) eventsByDay.set(startDate, []);
      eventsByDay.get(startDate).push(event);
    }
  }
  
  for (const [date, dayEvents] of eventsByDay) {
    const ungrouped = dayEvents.filter(e => !groupedEventIds.has(e.id));
    if (ungrouped.length < 2) continue;
    
    for (let i = 0; i < ungrouped.length; i++) {
      const event1 = ungrouped[i];
      if (groupedEventIds.has(event1.id)) continue;
      
      const similarGroup = [event1];
      const stripped1 = getOriginalTitle(event1.summary || '', allCalendars).toLowerCase();
      
      for (let j = i + 1; j < ungrouped.length; j++) {
        const event2 = ungrouped[j];
        if (groupedEventIds.has(event2.id)) continue;
        
        const stripped2 = getOriginalTitle(event2.summary || '', allCalendars).toLowerCase();
        
        const isSimilar = stripped1 === stripped2 ||
                         (stripped2.length >= 5 && stripped1.includes(stripped2)) || 
                         (stripped1.length >= 5 && stripped2.includes(stripped1)) ||
                         levenshteinSimilarity(stripped1, stripped2) > 0.75;
        
        if (isSimilar) {
          similarGroup.push(event2);
        }
      }
      
      if (similarGroup.length > 1) {
        similarGroup.sort(sortByOriginalFirst);
        duplicates.push({
          type: 'potential',
          key: `similar-day-${date}-${i}`,
          title: `Multiple similar events on ${date}`,
          time: date,
          events: similarGroup,
          count: similarGroup.length
        });
        similarGroup.forEach(e => groupedEventIds.add(e.id));
      }
    }
  }
  
  return duplicates;
}

// Simple Levenshtein distance similarity (0-1 scale)
function levenshteinSimilarity(str1, str2) {
  if (str1 === str2) return 1;
  if (!str1 || !str2) return 0;
  
  const len1 = str1.length;
  const len2 = str2.length;
  const maxLen = Math.max(len1, len2);
  
  if (maxLen === 0) return 1;
  
  const matrix = [];
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }
  
  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  
  const distance = matrix[len1][len2];
  return 1 - (distance / maxLen);
}

// Prepare event for syncing to target calendar
function prepareEventForSync(sourceEvent, sourceCal, allCalendars) {
  const originalTitle = getOriginalTitle(sourceEvent.summary || 'No Title', allCalendars);
  
  const syncedEvent = {
    summary: `${sourceCal.prefix || ''}${originalTitle}${sourceCal.suffix || ''}`,
    description: addSyncMarker(sourceEvent.description || '', sourceEvent.id, sourceCal.account_num),
    start: sourceEvent.start,
    end: sourceEvent.end,
    location: sourceEvent.location,
    reminders: { useDefault: true },
    transparency: sourceEvent.transparency || 'opaque',
    visibility: 'default'
  };
  
  // Handle all-day events
  if (sourceEvent.start?.date) {
    syncedEvent.start = { date: sourceEvent.start.date };
    syncedEvent.end = { date: sourceEvent.end.date };
  }
  
  return syncedEvent;
}

// Main sync function — supports N calendars
async function performSync() {
  const config = getSyncConfig();
  
  if (!config || !config.enabled) {
    console.log('Sync is not configured or not enabled');
    return { success: false, message: 'Sync not configured or disabled' };
  }
  
  const allCalendars = getEnabledCalendars();
  if (allCalendars.length < 2) {
    console.log('Need at least 2 calendars configured for sync');
    return { success: false, message: 'Need at least 2 calendars configured' };
  }
  
  // Verify both accounts are connected
  const accountNums = [...new Set(allCalendars.map(c => c.account_num))];
  const auths = {};
  for (const acct of accountNums) {
    const auth = getStoredAuthClient(acct);
    if (!auth) {
      console.log(`Account ${acct} not connected`);
      await notifyAccountDisconnected(acct, 'No stored tokens found.');
      return { success: false, message: `Account ${acct} not connected` };
    }
    auths[acct] = auth;
  }
  
  const results = {
    synced: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    duplicatesFound: 0,
    errors: []
  };
  
  try {
    // Fetch events from all calendars
    const calEvents = {};
    for (const cal of allCalendars) {
      console.log(`Fetching events from "${cal.calendar_name}" (account ${cal.account_num})...`);
      const { events } = await getEventsForSync(auths[cal.account_num], cal.calendar_id);
      calEvents[cal.id] = events;
      console.log(`  Found ${events.length} events`);
    }
    
    const biDirCals = allCalendars.filter(c => c.sync_mode === 'bidirectional');
    const oneWayCals = allCalendars.filter(c => c.sync_mode === 'one-way');
    
    // Bidirectional sync: each bidir cal syncs with every bidir cal on the OTHER account
    for (let i = 0; i < biDirCals.length; i++) {
      for (let j = i + 1; j < biDirCals.length; j++) {
        const calA = biDirCals[i];
        const calB = biDirCals[j];
        if (calA.account_num === calB.account_num) continue;
        
        const authA = auths[calA.account_num];
        const authB = auths[calB.account_num];
        
        // Sync A → B
        await syncEvents(calEvents[calA.id], calEvents[calB.id], authA, authB, calA, calB, allCalendars, results);
        // Sync B → A
        await syncEvents(calEvents[calB.id], calEvents[calA.id], authB, authA, calB, calA, allCalendars, results);
        // Cleanup orphaned
        await cleanupOrphanedEvents(calEvents[calA.id], authB, calB, calA, results);
        await cleanupOrphanedEvents(calEvents[calB.id], authA, calA, calB, results);
      }
    }
    
    // One-way sync: each one-way cal syncs to all bidir cals (except same calendar)
    for (const srcCal of oneWayCals) {
      for (const targetCal of biDirCals) {
        if (targetCal.calendar_id === srcCal.calendar_id) continue;
        const targetAuth = auths[targetCal.account_num];
        
        await syncOneWayEvents(calEvents[srcCal.id], calEvents[targetCal.id], targetAuth, srcCal, targetCal, allCalendars, results);
        await cleanupOrphanedEvents(calEvents[srcCal.id], targetAuth, targetCal, srcCal, results);
      }
    }
    
    updateLastSync();
    
    const message = `Sync complete: ${results.synced} created, ${results.updated} updated, ${results.deleted} deleted, ${results.skipped} skipped, ${results.duplicatesFound} duplicates found`;
    console.log(message);
    addSyncLog('sync_complete', null, null, 'success', message);
    await notifySyncRecovered();
    
    return { success: true, results, message };
  } catch (error) {
    console.error('Sync error:', error);
    addSyncLog('sync_error', null, null, 'error', error.message);
    const msg = error.message || '';
    if (msg.includes('invalid_grant') || msg.includes('Token has been expired or revoked')) {
      await notifyAccountDisconnected(0, msg);
    } else {
      await notifySyncFailure(msg);
    }
    return { success: false, message: error.message, results };
  }
}

// Clean up orphaned synced events where the source event no longer exists
async function cleanupOrphanedEvents(sourceEvents, targetAuth, targetCal, sourceCal, results) {
  const syncedRecords = getSyncedEventsByAccountAndTarget(sourceCal.account_num, targetCal.calendar_id);
  
  // Only consider records from this specific source calendar
  const relevantRecords = syncedRecords.filter(r => r.source_calendar_id === sourceCal.calendar_id);
  
  const sourceEventIds = new Set(sourceEvents.map(e => e.id));
  
  for (const record of relevantRecords) {
    if (sourceEventIds.has(record.source_event_id)) continue;
    
    try {
      await deleteEvent(targetAuth, targetCal.calendar_id, record.target_event_id);
      deleteSyncedEvent(record.source_event_id, sourceCal.account_num, targetCal.calendar_id);
      results.deleted++;
      addSyncLog('delete', sourceCal.account_num, `orphaned:${record.source_event_id}`, 'success', 'Deleted synced event (source was deleted)');
    } catch (err) {
      if (err.code === 404 || err.message?.includes('Not Found')) {
        deleteSyncedEvent(record.source_event_id, sourceCal.account_num, targetCal.calendar_id);
      } else {
        console.error(`Error deleting orphaned event ${record.target_event_id}:`, err.message);
        results.errors.push({ event: `orphaned:${record.source_event_id}`, error: err.message });
      }
    }
  }
}

// Sync events bidirectionally from source to target
async function syncEvents(sourceEvents, targetEvents, sourceAuth, targetAuth, sourceCal, targetCal, allCalendars, results) {
  const sourceAccount = sourceCal.account_num;
  const targetAccount = targetCal.account_num;
  
  for (const sourceEvent of sourceEvents) {
    try {
      // Skip cancelled events
      if (sourceEvent.status === 'cancelled') {
        const syncedRecord = getSyncedEvent(sourceEvent.id, sourceAccount, targetCal.calendar_id);
        if (syncedRecord) {
          try {
            await deleteEvent(targetAuth, targetCal.calendar_id, syncedRecord.target_event_id);
            deleteSyncedEvent(sourceEvent.id, sourceAccount, targetCal.calendar_id);
            results.deleted++;
            addSyncLog('delete', sourceAccount, sourceEvent.summary, 'success', 'Deleted cancelled event');
          } catch (err) {
            deleteSyncedEvent(sourceEvent.id, sourceAccount, targetCal.calendar_id);
          }
        }
        continue;
      }
      
      // Check if this event was synced FROM the other account (avoid ping-pong)
      const marker = extractSyncMarker(sourceEvent.description);
      if (marker && marker.sourceAccount === targetAccount) {
        results.skipped++;
        continue;
      }
      
      // Check if we already synced this event to this target
      const existingSyncRecord = getSyncedEvent(sourceEvent.id, sourceAccount, targetCal.calendar_id);
      const eventHash = createEventHash(sourceEvent);
      
      if (existingSyncRecord) {
        if (existingSyncRecord.event_hash === eventHash) {
          results.skipped++;
          continue;
        }
        
        try {
          const updatedEvent = prepareEventForSync(sourceEvent, sourceCal, allCalendars);
          await updateEvent(targetAuth, targetCal.calendar_id, existingSyncRecord.target_event_id, updatedEvent);
          saveSyncedEvent(sourceAccount, sourceEvent.id, existingSyncRecord.target_event_id, 
            sourceCal.calendar_id, targetCal.calendar_id, eventHash);
          results.updated++;
          addSyncLog('update', sourceAccount, sourceEvent.summary, 'success', 'Updated changed event');
        } catch (err) {
          console.error(`Error updating event ${sourceEvent.id}:`, err.message);
          results.errors.push({ event: sourceEvent.summary, error: err.message });
          addSyncLog('update', sourceAccount, sourceEvent.summary, 'error', err.message);
        }
        continue;
      }
      
      // Check if exact synced version already exists in target
      const existingDup = findExistingDuplicate(sourceEvent, sourceCal, targetEvents, allCalendars);
      if (existingDup) {
        console.log(`Exact synced version already exists: "${existingDup.summary}" - linking`);
        saveSyncedEvent(sourceAccount, sourceEvent.id, existingDup.id,
          sourceCal.calendar_id, targetCal.calendar_id, eventHash);
        results.skipped++;
        addSyncLog('auto_linked', sourceAccount, sourceEvent.summary, 'success', 
          `Linked to existing "${existingDup.summary}"`);
        continue;
      }
      
      // Create new event in target calendar
      try {
        const newEvent = prepareEventForSync(sourceEvent, sourceCal, allCalendars);
        const createdEvent = await createEvent(targetAuth, targetCal.calendar_id, newEvent);
        
        saveSyncedEvent(sourceAccount, sourceEvent.id, createdEvent.id,
          sourceCal.calendar_id, targetCal.calendar_id, eventHash);
        
        results.synced++;
        addSyncLog('create', sourceAccount, sourceEvent.summary, 'success', 'Created new synced event');
      } catch (err) {
        console.error(`Error creating event ${sourceEvent.id}:`, err.message);
        results.errors.push({ event: sourceEvent.summary, error: err.message });
        addSyncLog('create', sourceAccount, sourceEvent.summary, 'error', err.message);
      }
    } catch (err) {
      console.error(`Error processing event:`, err);
      results.errors.push({ event: sourceEvent.summary || 'Unknown', error: err.message });
    }
  }
}

// Sync events one-way from source to target
async function syncOneWayEvents(sourceEvents, targetEvents, targetAuth, sourceCal, targetCal, allCalendars, results) {
  const sourceAccount = sourceCal.account_num;
  
  for (const sourceEvent of sourceEvents) {
    try {
      if (sourceEvent.status === 'cancelled') {
        const syncedRecord = getSyncedEvent(sourceEvent.id, sourceAccount, targetCal.calendar_id);
        if (syncedRecord) {
          try {
            await deleteEvent(targetAuth, targetCal.calendar_id, syncedRecord.target_event_id);
            deleteSyncedEvent(sourceEvent.id, sourceAccount, targetCal.calendar_id);
            results.deleted++;
            addSyncLog('delete', sourceAccount, sourceEvent.summary, 'success', 'Deleted cancelled one-way event');
          } catch (err) {
            deleteSyncedEvent(sourceEvent.id, sourceAccount, targetCal.calendar_id);
          }
        }
        continue;
      }
      
      // Skip if this event already has a sync marker (it's a synced copy)
      const marker = extractSyncMarker(sourceEvent.description);
      if (marker) continue;
      
      const existingSyncRecord = getSyncedEvent(sourceEvent.id, sourceAccount, targetCal.calendar_id);
      const eventHash = createEventHash(sourceEvent);
      
      if (existingSyncRecord) {
        if (existingSyncRecord.event_hash === eventHash) {
          results.skipped++;
          continue;
        }
        
        try {
          const updatedEvent = prepareEventForSync(sourceEvent, sourceCal, allCalendars);
          await updateEvent(targetAuth, targetCal.calendar_id, existingSyncRecord.target_event_id, updatedEvent);
          saveSyncedEvent(sourceAccount, sourceEvent.id, existingSyncRecord.target_event_id,
            sourceCal.calendar_id, targetCal.calendar_id, eventHash);
          results.updated++;
          addSyncLog('update', sourceAccount, sourceEvent.summary, 'success', 'Updated one-way event');
        } catch (err) {
          console.error(`Error updating one-way event ${sourceEvent.id}:`, err.message);
          results.errors.push({ event: sourceEvent.summary, error: err.message });
          addSyncLog('update', sourceAccount, sourceEvent.summary, 'error', err.message);
        }
        continue;
      }
      
      // Check for existing duplicate in target
      const syncedTitle = `${sourceCal.prefix || ''}${sourceEvent.summary || 'No Title'}${sourceCal.suffix || ''}`;
      const eventStart = sourceEvent.start?.dateTime || sourceEvent.start?.date;
      const existingDup = targetEvents.find(e => {
        const eStart = e.start?.dateTime || e.start?.date;
        return eStart === eventStart && e.summary?.toLowerCase() === syncedTitle.toLowerCase();
      });
      
      if (existingDup) {
        console.log(`One-way event already exists in target: "${existingDup.summary}" - linking`);
        saveSyncedEvent(sourceAccount, sourceEvent.id, existingDup.id,
          sourceCal.calendar_id, targetCal.calendar_id, eventHash);
        results.skipped++;
        addSyncLog('auto_linked', sourceAccount, sourceEvent.summary, 'success',
          `Linked to existing "${existingDup.summary}"`);
        continue;
      }
      
      // Create new event in target
      try {
        const newEvent = prepareEventForSync(sourceEvent, sourceCal, allCalendars);
        const createdEvent = await createEvent(targetAuth, targetCal.calendar_id, newEvent);
        
        saveSyncedEvent(sourceAccount, sourceEvent.id, createdEvent.id,
          sourceCal.calendar_id, targetCal.calendar_id, eventHash);
        
        results.synced++;
        addSyncLog('create', sourceAccount, sourceEvent.summary, 'success', 'Created one-way synced event');
      } catch (err) {
        console.error(`Error creating one-way event ${sourceEvent.id}:`, err.message);
        results.errors.push({ event: sourceEvent.summary, error: err.message });
        addSyncLog('create', sourceAccount, sourceEvent.summary, 'error', err.message);
      }
    } catch (err) {
      console.error(`Error processing one-way event:`, err);
      results.errors.push({ event: sourceEvent.summary || 'Unknown', error: err.message });
    }
  }
}

// --- ICS Feed Generation ---

function escapeICS(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n/g, '\\n')
    .replace(/\r/g, '\\n')
    .replace(/\n/g, '\\n');
}

// RFC 5545 requires content lines <= 75 octets. Fold long lines.
function foldLine(line) {
  if (Buffer.byteLength(line, 'utf8') <= 75) return line;
  
  const result = [];
  let remaining = line;
  let first = true;
  
  while (Buffer.byteLength(remaining, 'utf8') > 75) {
    // For the first chunk, max 75 bytes. For continuation lines, 74 (leading space takes 1).
    const maxBytes = first ? 75 : 74;
    let cutPoint = 0;
    let byteCount = 0;
    
    for (let i = 0; i < remaining.length; i++) {
      const charBytes = Buffer.byteLength(remaining[i], 'utf8');
      if (byteCount + charBytes > maxBytes) break;
      byteCount += charBytes;
      cutPoint = i + 1;
    }
    
    result.push(remaining.substring(0, cutPoint));
    remaining = remaining.substring(cutPoint);
    first = false;
  }
  
  if (remaining.length > 0) {
    result.push(remaining);
  }
  
  return result.join('\r\n ');
}

function formatDateTimeICS(dateTime) {
  const d = new Date(dateTime);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function formatDateICS(date) {
  return date.replace(/-/g, '');
}

// Generate a stable UID from a Google event ID (some IDs have chars not ideal for UID)
function makeUID(eventId) {
  const safe = (eventId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return `${safe || crypto.randomUUID()}@calendar-sync`;
}

export function generateICS(events, calendarName) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//CalendarSync//Combined//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldLine(`X-WR-CALNAME:${escapeICS(calendarName || 'All Calendars')}`),
    'REFRESH-INTERVAL;VALUE=DURATION:PT5M',
    'X-PUBLISHED-TTL:PT5M',
  ];
  
  const now = formatDateTimeICS(new Date().toISOString());
  
  for (const event of events) {
    if (event.status === 'cancelled') continue;
    
    // Must have at least a start time
    const hasDateTime = event.start?.dateTime;
    const hasDate = event.start?.date;
    if (!hasDateTime && !hasDate) continue;
    
    const eventLines = [];
    eventLines.push('BEGIN:VEVENT');
    
    eventLines.push(foldLine(`UID:${makeUID(event.id)}`));
    eventLines.push(`DTSTAMP:${now}`);
    
    if (hasDateTime) {
      const dtStart = formatDateTimeICS(event.start.dateTime);
      const dtEnd = formatDateTimeICS(event.end?.dateTime || event.start.dateTime);
      if (!dtStart) continue; // Skip events with invalid dates
      eventLines.push(`DTSTART:${dtStart}`);
      eventLines.push(`DTEND:${dtEnd || dtStart}`);
    } else if (hasDate) {
      eventLines.push(`DTSTART;VALUE=DATE:${formatDateICS(event.start.date)}`);
      eventLines.push(`DTEND;VALUE=DATE:${formatDateICS(event.end?.date || event.start.date)}`);
    }
    
    if (event.summary) {
      eventLines.push(foldLine(`SUMMARY:${escapeICS(event.summary)}`));
    } else {
      eventLines.push('SUMMARY:(No title)');
    }
    
    if (event.description) {
      const cleanDesc = event.description.replace(/\n*<!-- CalSync:\d+:[^\s]+ -->/g, '').trim();
      if (cleanDesc) {
        eventLines.push(foldLine(`DESCRIPTION:${escapeICS(cleanDesc)}`));
      }
    }
    
    if (event.location) {
      eventLines.push(foldLine(`LOCATION:${escapeICS(event.location)}`));
    }
    
    if (event.status === 'tentative') {
      eventLines.push('STATUS:TENTATIVE');
    } else {
      eventLines.push('STATUS:CONFIRMED');
    }
    
    if (event.transparency === 'transparent') {
      eventLines.push('TRANSP:TRANSPARENT');
    } else {
      eventLines.push('TRANSP:OPAQUE');
    }
    
    eventLines.push('END:VEVENT');
    lines.push(...eventLines);
  }
  
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// Fetch all events from all calendars, deduplicate, return combined list
export async function getCombinedEvents() {
  const allCalendars = getEnabledCalendars();
  if (allCalendars.length === 0) return { events: [], calendars: allCalendars };
  
  const accountNums = [...new Set(allCalendars.map(c => c.account_num))];
  const auths = {};
  for (const acct of accountNums) {
    auths[acct] = getStoredAuthClient(acct);
    if (!auths[acct]) throw new Error(`Account ${acct} not connected`);
  }
  
  // Fetch all events
  const allEvents = [];
  for (const cal of allCalendars) {
    const { events } = await getEventsForSync(auths[cal.account_num], cal.calendar_id);
    for (const event of events) {
      if (event.status === 'cancelled') continue;
      event._calendarName = cal.calendar_name;
      event._calendarPrefix = cal.prefix;
      allEvents.push(event);
    }
  }
  
  // Deduplicate: group by original title + start time, keep one per group
  const { prefixes, suffixes } = getAllAffixes(allCalendars);
  const seen = new Map();
  
  for (const event of allEvents) {
    let title = event.summary || '';
    // Strip all known prefixes/suffixes to find the original title
    let stripped = stripAllPrefixes(title, prefixes);
    stripped = stripAllSuffixes(stripped, suffixes);
    
    const startTime = event.start?.dateTime || event.start?.date || '';
    const key = `${stripped.toLowerCase()}|${startTime}`;
    
    if (!seen.has(key)) {
      seen.set(key, event);
    }
    // Keep the first occurrence (already has a prefix identifying the source)
  }
  
  const dedupedEvents = Array.from(seen.values());
  
  // Sort by start time
  dedupedEvents.sort((a, b) => {
    const aStart = a.start?.dateTime || a.start?.date || '';
    const bStart = b.start?.dateTime || b.start?.date || '';
    return aStart.localeCompare(bStart);
  });
  
  return { events: dedupedEvents, calendars: allCalendars };
}

// --- API Routes ---

// Get sync configuration + calendars list
syncRouter.get('/config', (req, res) => {
  const config = getSyncConfig();
  const calendars = getCalendars();
  res.json({ ...(config || {}), calendars });
});

// Save sync configuration (simplified — just enabled state)
syncRouter.post('/config', (req, res) => {
  const { enabled } = req.body;
  if (enabled !== undefined) {
    saveSyncEnabled(enabled);
  }
  res.json({ success: true });
});

// Calendar CRUD
syncRouter.get('/calendars', (req, res) => {
  res.json(getCalendars());
});

syncRouter.post('/calendars', (req, res) => {
  const { accountNum, calendarId, calendarName, prefix, suffix, syncMode } = req.body;
  
  if (!accountNum || !calendarId) {
    return res.status(400).json({ error: 'accountNum and calendarId are required' });
  }
  
  try {
    const id = saveCalendar({ accountNum, calendarId, calendarName, prefix, suffix, syncMode });
    res.json({ success: true, id });
  } catch (err) {
    if (err.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Calendar already added' });
    }
    res.status(500).json({ error: err.message });
  }
});

syncRouter.put('/calendars/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const { calendarName, prefix, suffix, syncMode, enabled } = req.body;
  
  const existing = getCalendarById(id);
  if (!existing) {
    return res.status(404).json({ error: 'Calendar not found' });
  }
  
  updateCalendar(id, { calendarName, prefix, suffix, syncMode, enabled });
  res.json({ success: true });
});

syncRouter.delete('/calendars/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const existing = getCalendarById(id);
  if (!existing) {
    return res.status(404).json({ error: 'Calendar not found' });
  }
  
  removeCalendar(id);
  res.json({ success: true });
});

// Trigger manual sync
syncRouter.post('/now', async (req, res) => {
  const result = await performSync();
  res.json(result);
});

// Get sync logs
syncRouter.get('/logs', (req, res) => {
  const logs = getSyncLogs(100);
  res.json(logs);
});

// Get synced events list  
syncRouter.get('/events', (req, res) => {
  const events = getAllSyncedEvents();
  res.json(events);
});

// Enable/disable sync
syncRouter.post('/toggle', (req, res) => {
  const config = getSyncConfig();
  if (config) {
    const newEnabled = !config.enabled;
    saveSyncEnabled(newEnabled);
    res.json({ enabled: newEnabled });
  } else {
    saveSyncEnabled(true);
    res.json({ enabled: true });
  }
});

// Get pending duplicates for review
syncRouter.get('/duplicates', (req, res) => {
  const duplicates = getPendingDuplicates();
  res.json(duplicates);
});

// Resolve a duplicate
syncRouter.post('/duplicates/:id/resolve', async (req, res) => {
  const id = parseInt(req.params.id);
  const { action } = req.body;
  
  const duplicate = getPendingDuplicate(id);
  if (!duplicate) {
    return res.status(404).json({ error: 'Duplicate not found' });
  }
  
  const allCalendars = getCalendars();
  
  try {
    if (action === 'sync') {
      const sourceAccount = duplicate.source_account;
      const targetAccount = sourceAccount === 1 ? 2 : 1;
      const auth = getStoredAuthClient(targetAccount);
      
      // Find appropriate source/target calendar  
      const sourceCals = allCalendars.filter(c => c.account_num === sourceAccount && c.sync_mode === 'bidirectional');
      const targetCals = allCalendars.filter(c => c.account_num === targetAccount && c.sync_mode === 'bidirectional');
      
      if (!sourceCals.length || !targetCals.length) {
        return res.status(400).json({ error: 'No bidirectional calendars configured for both accounts' });
      }
      
      const sourceCal = sourceCals[0];
      const targetCal = targetCals[0];
      
      const newEvent = prepareEventForSync(duplicate.source_event_data, sourceCal, allCalendars);
      const createdEvent = await createEvent(auth, targetCal.calendar_id, newEvent);
      
      const eventHash = createEventHash(duplicate.source_event_data);
      saveSyncedEvent(sourceAccount, duplicate.source_event_id, createdEvent.id,
        sourceCal.calendar_id, targetCal.calendar_id, eventHash);
      
      deletePendingDuplicate(id);
      addSyncLog('duplicate_synced', sourceAccount, duplicate.source_event_data.summary, 'success', 
        'User approved - created synced copy');
      
      res.json({ success: true, action: 'synced', eventId: createdEvent.id });
      
    } else if (action === 'link') {
      const sourceAccount = duplicate.source_account;
      const eventHash = createEventHash(duplicate.source_event_data);
      
      const sourceCals = allCalendars.filter(c => c.account_num === sourceAccount && c.sync_mode === 'bidirectional');
      const targetAccount = sourceAccount === 1 ? 2 : 1;
      const targetCals = allCalendars.filter(c => c.account_num === targetAccount && c.sync_mode === 'bidirectional');
      
      if (sourceCals.length && targetCals.length) {
        saveSyncedEvent(sourceAccount, duplicate.source_event_id, duplicate.existing_event_id,
          sourceCals[0].calendar_id, targetCals[0].calendar_id, eventHash);
      }
      
      deletePendingDuplicate(id);
      addSyncLog('duplicate_linked', sourceAccount, duplicate.source_event_data.summary, 'success', 
        `User linked to existing event "${duplicate.existing_event_data.summary}"`);
      
      res.json({ success: true, action: 'linked' });
      
    } else if (action === 'skip') {
      updatePendingDuplicateStatus(id, 'skipped');
      addSyncLog('duplicate_skipped', duplicate.source_account, duplicate.source_event_data.summary, 'info', 
        'User chose to skip');
      
      res.json({ success: true, action: 'skipped' });
      
    } else {
      res.status(400).json({ error: 'Invalid action. Use: sync, link, or skip' });
    }
  } catch (error) {
    console.error('Error resolving duplicate:', error);
    res.status(500).json({ error: 'Failed to resolve duplicate', details: error.message });
  }
});

// Batch resolve duplicates
syncRouter.post('/duplicates/batch', async (req, res) => {
  const { actions } = req.body;
  const results = { success: 0, failed: 0, errors: [] };
  
  for (const { id, action } of actions) {
    try {
      const duplicate = getPendingDuplicate(id);
      if (!duplicate) {
        results.failed++;
        results.errors.push({ id, error: 'Not found' });
        continue;
      }
      
      if (action === 'skip') {
        updatePendingDuplicateStatus(id, 'skipped');
        addSyncLog('duplicate_skipped', duplicate.source_account, duplicate.source_event_data.summary, 'info', 
          'Batch skipped');
      } else if (action === 'link') {
        const sourceAccount = duplicate.source_account;
        const eventHash = createEventHash(duplicate.source_event_data);
        const allCals = getCalendars();
        const sourceCals = allCals.filter(c => c.account_num === sourceAccount && c.sync_mode === 'bidirectional');
        const targetAccount = sourceAccount === 1 ? 2 : 1;
        const targetCals = allCals.filter(c => c.account_num === targetAccount && c.sync_mode === 'bidirectional');
        
        if (sourceCals.length && targetCals.length) {
          saveSyncedEvent(sourceAccount, duplicate.source_event_id, duplicate.existing_event_id,
            sourceCals[0].calendar_id, targetCals[0].calendar_id, eventHash);
        }
        deletePendingDuplicate(id);
        addSyncLog('duplicate_linked', sourceAccount, duplicate.source_event_data.summary, 'success', 'Batch linked');
      }
      
      results.success++;
    } catch (error) {
      results.failed++;
      results.errors.push({ id, error: error.message });
    }
  }
  
  res.json(results);
});

// Scan for TRUE duplicates within each calendar
syncRouter.get('/scan-duplicates', async (req, res) => {
  const allCalendars = getEnabledCalendars();
  
  if (allCalendars.length === 0) {
    return res.status(400).json({ error: 'No calendars configured' });
  }
  
  const accountNums = [...new Set(allCalendars.map(c => c.account_num))];
  const auths = {};
  for (const acct of accountNums) {
    auths[acct] = getStoredAuthClient(acct);
    if (!auths[acct]) {
      return res.status(400).json({ error: `Account ${acct} not connected` });
    }
  }
  
  try {
    const calendarResults = [];
    
    for (const cal of allCalendars) {
      const { events } = await getEventsForSync(auths[cal.account_num], cal.calendar_id);
      const duplicates = findDuplicatesInCalendar(events, allCalendars);
      
      calendarResults.push({
        id: cal.id,
        name: cal.calendar_name,
        accountNum: cal.account_num,
        duplicates: duplicates.map(d => ({
          type: d.type,
          title: d.title,
          time: d.time,
          count: d.count,
          events: d.events.map(e => ({
            id: e.id,
            summary: e.summary,
            start: e.start,
            end: e.end
          }))
        }))
      });
    }
    
    res.json({ calendars: calendarResults });
  } catch (error) {
    console.error('Error scanning for duplicates:', error);
    res.status(500).json({ error: 'Failed to scan for duplicates', details: error.message });
  }
});

// Batch delete multiple events
syncRouter.post('/delete-batch', async (req, res) => {
  const { events } = req.body;
  const allCalendars = getCalendars();
  
  const results = { deleted: 0, failed: 0, errors: [] };
  
  for (const { accountNum, calendarId, eventId } of events) {
    const auth = getStoredAuthClient(accountNum);
    if (!auth) {
      results.failed++;
      results.errors.push({ eventId, error: 'Account not connected' });
      continue;
    }
    
    const calId = calendarId || allCalendars.find(c => c.account_num === accountNum)?.calendar_id;
    if (!calId) {
      results.failed++;
      results.errors.push({ eventId, error: 'No calendar found for account' });
      continue;
    }
    
    try {
      await deleteEvent(auth, calId, eventId);
      results.deleted++;
    } catch (error) {
      results.failed++;
      results.errors.push({ eventId, error: error.message });
    }
  }
  
  if (results.deleted > 0) {
    addSyncLog('batch_delete', null, `${results.deleted} events`, 'success', 
      `Batch deleted ${results.deleted} duplicate events`);
  }
  
  res.json(results);
});

// Delete a specific event
syncRouter.delete('/event/:accountNum/:calendarId/:eventId', async (req, res) => {
  const accountNum = parseInt(req.params.accountNum);
  const calendarId = decodeURIComponent(req.params.calendarId);
  const eventId = req.params.eventId;
  
  const auth = getStoredAuthClient(accountNum);
  if (!auth) {
    return res.status(400).json({ error: 'Account not connected' });
  }
  
  try {
    await deleteEvent(auth, calendarId, eventId);
    addSyncLog('delete_duplicate', accountNum, eventId, 'success', 'User deleted event');
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting event:', error);
    res.status(500).json({ error: 'Failed to delete event', details: error.message });
  }
});

// Backward-compatible: delete by accountNum + eventId (uses first calendar for that account)
syncRouter.delete('/event/:accountNum/:eventId', (req, res, next) => {
  // If calendarId looks like a Google event ID (no dots/@ signs), treat as old format
  const maybeCalId = req.params.calendarId;
  if (maybeCalId === undefined) {
    // Old format: /event/:accountNum/:eventId
    const accountNum = parseInt(req.params.accountNum);
    const eventId = req.params.eventId;
    const allCals = getCalendars();
    const cal = allCals.find(c => c.account_num === accountNum);
    if (cal) {
      req.params.calendarId = cal.calendar_id;
    }
  }
  next();
});

// ICS combined feed
syncRouter.get('/ics', async (req, res) => {
  const token = req.query.token;
  const expectedToken = getIcsToken();
  
  if (!expectedToken || token !== expectedToken) {
    // Return valid but empty ICS on auth failure (Apple rejects non-ICS responses)
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="combined.ics"'
    });
    return res.send('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//CalendarSync//Combined//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:Unauthorized\r\nEND:VCALENDAR\r\n');
  }
  
  try {
    const { events } = await getCombinedEvents();
    const ics = generateICS(events, 'All Calendars');
    
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="combined.ics"',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.send(ics);
  } catch (error) {
    console.error('Error generating ICS feed:', error);
    // Still return valid ICS so Apple Calendar doesn't reject the subscription
    res.set({
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="combined.ics"'
    });
    res.send('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//CalendarSync//Combined//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\nX-WR-CALNAME:All Calendars\r\nEND:VCALENDAR\r\n');
  }
});

// Get ICS feed URL info
syncRouter.get('/ics-info', (req, res) => {
  const token = getIcsToken();
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
  res.json({
    url: token ? `${baseUrl}/api/sync/ics?token=${token}` : null,
    token
  });
});

// Background sync scheduler
let syncInterval = null;

export function startSyncScheduler() {
  const intervalMinutes = parseInt(process.env.SYNC_INTERVAL_MINUTES) || 5;
  
  console.log(`Starting sync scheduler (every ${intervalMinutes} minutes)`);
  
  // Run initial sync after 30 seconds
  setTimeout(async () => {
    console.log('Running initial sync...');
    await performSync();
  }, 30000);
  
  // Schedule recurring syncs
  syncInterval = setInterval(async () => {
    console.log('Running scheduled sync...');
    await performSync();
  }, intervalMinutes * 60 * 1000);
}

export function stopSyncScheduler() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

export { performSync };
