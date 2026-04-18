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
  isPendingDuplicate
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

// Check if event title already has a prefix
function hasPrefix(title, prefix1, prefix2) {
  return title?.startsWith(prefix1) || title?.startsWith(prefix2);
}

// Strip existing prefix from title
function stripPrefix(title, prefix1, prefix2) {
  if (!title) return '';
  let result = title;
  // Strip known prefixes
  if (result.toUpperCase().startsWith(prefix1.toUpperCase())) result = result.substring(prefix1.length);
  if (result.toUpperCase().startsWith(prefix2.toUpperCase())) result = result.substring(prefix2.length);
  // Strip any remaining bracket prefixes like [HOLD], [PENDING], etc.
  result = result.replace(/^\[[^\]]+\]\s*/g, '');
  return result.trim();
}

// Check for TRUE duplicate: the exact synced version already exists in target calendar
// (e.g., "[PHOTO] Sara Wedding" trying to be created when "[PHOTO] Sara Wedding" already exists)
// This catches leftover duplicates from tools like ActivePieces
function findExistingDuplicate(event, prefix, existingEvents, config) {
  const eventStart = event.start?.dateTime || event.start?.date;
  const syncedTitle = `${prefix}${stripPrefix(event.summary || '', config.prefix_1, config.prefix_2)}`;
  
  for (const existing of existingEvents) {
    const existingStart = existing.start?.dateTime || existing.start?.date;
    
    // Check if the EXACT synced version already exists (same prefixed title, same time)
    if (eventStart === existingStart && 
        existing.summary?.toLowerCase() === syncedTitle.toLowerCase()) {
      return existing;
    }
  }
  
  return null;
}

// Check for duplicates WITHIN a calendar
// Includes: exact matches AND potential duplicates (similar titles on same day)
function findDuplicatesInCalendar(events, config, accountNum) {
  const duplicates = [];
  const exactMatches = new Map(); // key: "title|startTime" -> array of events
  const photoEventsByDay = new Map(); // key: "date" -> array of [PHOTO] events
  
  const prefix1Upper = (config.prefix_1 || '').toUpperCase();
  const prefix2Upper = (config.prefix_2 || '').toUpperCase();
  
  // Helper to check if event has both prefixes (corrupted)
  const hasBothPrefixes = (summary) => {
    const upper = (summary || '').toUpperCase();
    return upper.includes(prefix1Upper) && upper.includes(prefix2Upper);
  };
  
  // Helper to check if event has [PHOTO] prefix
  const hasPhotoPrefix = (summary) => {
    return (summary || '').toUpperCase().includes(prefix1Upper);
  };
  
  // Sort function: prioritize events WITHOUT ANY prefix (originals first)
  const sortByOriginalFirst = (a, b) => {
    const aSummary = (a.summary || '').toUpperCase();
    const bSummary = (b.summary || '').toUpperCase();
    
    const aHasPrefix = aSummary.includes(prefix1Upper) || aSummary.includes(prefix2Upper);
    const bHasPrefix = bSummary.includes(prefix1Upper) || bSummary.includes(prefix2Upper);
    if (aHasPrefix && !bHasPrefix) return 1;  // a has prefix, b is original -> b first
    if (!aHasPrefix && bHasPrefix) return -1; // a is original, b has prefix -> a first
    return 0;
  };
  
  // Track which events have already been grouped
  const groupedEventIds = new Set();
  
  // First pass: find corrupted events (have both prefixes)
  const corruptedEvents = [];
  for (const event of events) {
    if (event.status === 'cancelled') continue;
    
    if (hasBothPrefixes(event.summary)) {
      corruptedEvents.push(event);
      groupedEventIds.add(event.id);
    }
  }
  
  if (corruptedEvents.length > 0) {
    duplicates.push({
      type: 'corrupted',
      key: 'corrupted-both-prefixes',
      title: `Corrupted: Has both ${config.prefix_1} and ${config.prefix_2}`,
      time: 'Various',
      events: corruptedEvents,
      count: corruptedEvents.length,
      deleteAll: true
    });
  }
  
  // Second pass: collect events for grouping
  for (const event of events) {
    if (event.status === 'cancelled') continue;
    if (groupedEventIds.has(event.id)) continue;
    
    const startDateTime = event.start?.dateTime || event.start?.date || '';
    const startDate = startDateTime.split('T')[0];
    const title = (event.summary || '').toLowerCase();
    const exactKey = `${title}|${startDateTime}`;
    
    // Track exact matches (same title, same time)
    if (!exactMatches.has(exactKey)) {
      exactMatches.set(exactKey, []);
    }
    exactMatches.get(exactKey).push(event);
    
    // Track [PHOTO] events by day (only one allowed per day)
    if (hasPhotoPrefix(event.summary)) {
      if (!photoEventsByDay.has(startDate)) {
        photoEventsByDay.set(startDate, []);
      }
      photoEventsByDay.get(startDate).push(event);
    }
  }
  
  // Find exact duplicates (same title, same time)
  for (const [key, eventGroup] of exactMatches) {
    if (eventGroup.length > 1) {
      // Filter out already grouped
      const ungrouped = eventGroup.filter(e => !groupedEventIds.has(e.id));
      if (ungrouped.length < 2) continue;
      
      // Sort so originals come first (will be "kept")
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
  
  // Find multiple [PHOTO] events on same day with similar titles
  for (const [date, photoEvents] of photoEventsByDay) {
    // Filter out already grouped
    const ungrouped = photoEvents.filter(e => !groupedEventIds.has(e.id));
    if (ungrouped.length < 2) continue;
    
    // Group by similar titles within this day's [PHOTO] events
    for (let i = 0; i < ungrouped.length; i++) {
      const event1 = ungrouped[i];
      if (groupedEventIds.has(event1.id)) continue;
      
      const similarGroup = [event1];
      const stripped1 = stripPrefix(event1.summary || '', config.prefix_1, config.prefix_2).toLowerCase();
      
      for (let j = i + 1; j < ungrouped.length; j++) {
        const event2 = ungrouped[j];
        if (groupedEventIds.has(event2.id)) continue;
        
        const stripped2 = stripPrefix(event2.summary || '', config.prefix_1, config.prefix_2).toLowerCase();
        
        // Check if titles are similar (must be meaningful matches)
        const isSimilar = stripped1 === stripped2 ||
                         (stripped2.length >= 5 && stripped1.includes(stripped2)) || 
                         (stripped1.length >= 5 && stripped2.includes(stripped1)) ||
                         levenshteinSimilarity(stripped1, stripped2) > 0.75;
        
        if (isSimilar) {
          similarGroup.push(event2);
        }
      }
      
      if (similarGroup.length > 1) {
        // Sort so originals (without prefix) come first
        similarGroup.sort(sortByOriginalFirst);
        
        duplicates.push({
          type: 'potential',
          key: `photo-day-${date}-${i}`,
          title: `Multiple similar ${config.prefix_1} on ${date}`,
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
  
  // Create distance matrix
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
function prepareEventForSync(sourceEvent, prefix, sourceAccount, config) {
  const originalTitle = stripPrefix(sourceEvent.summary || 'No Title', config.prefix_1, config.prefix_2);
  
  const syncedEvent = {
    summary: `${prefix}${originalTitle}`,
    description: addSyncMarker(sourceEvent.description || '', sourceEvent.id, sourceAccount),
    start: sourceEvent.start,
    end: sourceEvent.end,
    location: sourceEvent.location,
    // Don't sync attendees to avoid permission issues
    // attendees: sourceEvent.attendees,
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

// Prepare event for syncing from calendar 3 (add prefix from cal1 + append suffix)
function prepareEventForCal3(sourceEvent, prefix, suffix) {
  const syncedEvent = {
    summary: prefix + (sourceEvent.summary || 'No Title') + suffix,
    description: addSyncMarker(sourceEvent.description || '', sourceEvent.id, 3),
    start: sourceEvent.start,
    end: sourceEvent.end,
    location: sourceEvent.location,
    reminders: { useDefault: true },
    transparency: sourceEvent.transparency || 'opaque',
    visibility: 'default'
  };

  if (sourceEvent.start?.date) {
    syncedEvent.start = { date: sourceEvent.start.date };
    syncedEvent.end = { date: sourceEvent.end.date };
  }

  return syncedEvent;
}

// Main sync function
async function performSync() {
  const config = getSyncConfig();
  
  if (!config || !config.enabled) {
    console.log('Sync is not configured or not enabled');
    return { success: false, message: 'Sync not configured or disabled' };
  }
  
  const auth1 = getStoredAuthClient(1);
  const auth2 = getStoredAuthClient(2);
  
  if (!auth1 || !auth2) {
    console.log('Both accounts must be connected for sync');
    if (!auth1) await notifyAccountDisconnected(1, 'No stored tokens found.');
    if (!auth2) await notifyAccountDisconnected(2, 'No stored tokens found.');
    return { success: false, message: 'Both accounts must be connected' };
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
    // Get events from both calendars
    console.log('Fetching events from calendar 1...');
    const { events: events1 } = await getEventsForSync(auth1, config.calendar_id_1);
    
    console.log('Fetching events from calendar 2...');
    const { events: events2 } = await getEventsForSync(auth2, config.calendar_id_2);
    
    console.log(`Found ${events1.length} events in calendar 1, ${events2.length} events in calendar 2`);
    
    // Sync from account 1 to account 2
    await syncEvents(events1, events2, auth1, auth2, config, 1, results);
    
    // Sync from account 2 to account 1
    await syncEvents(events2, events1, auth2, auth1, config, 2, results);
    
    // Clean up orphaned synced events (source event was deleted entirely)
    await cleanupOrphanedEvents(events1, auth2, config.calendar_id_2, 1, results);
    await cleanupOrphanedEvents(events2, auth1, config.calendar_id_1, 2, results);
    
    // Sync calendar 3 (one-way) to both calendars if configured
    if (config.calendar_id_3) {
      console.log('Fetching events from calendar 3 (wedding)...');
      const { events: events3 } = await getEventsForSync(auth1, config.calendar_id_3);
      console.log(`Found ${events3.length} events in calendar 3`);
      
      // Sync cal3 to cal1 (same account)
      await syncCal3Events(events3, events1, auth1, config.calendar_id_1, config.calendar_id_3, config, results);
      // Sync cal3 to cal2
      await syncCal3Events(events3, events2, auth2, config.calendar_id_2, config.calendar_id_3, config, results);
      
      // Clean up orphaned cal3 synced events
      await cleanupOrphanedEvents(events3, auth1, config.calendar_id_1, 3, results);
      await cleanupOrphanedEvents(events3, auth2, config.calendar_id_2, 3, results);
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
    // Check if it's an auth error for a specific account
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
async function cleanupOrphanedEvents(sourceEvents, targetAuth, targetCalendarId, sourceAccount, results) {
  const syncedRecords = getSyncedEventsByAccountAndTarget(sourceAccount, targetCalendarId);
  
  // Build a set of current source event IDs for fast lookup
  const sourceEventIds = new Set(sourceEvents.map(e => e.id));
  
  for (const record of syncedRecords) {
    if (sourceEventIds.has(record.source_event_id)) continue;
    
    // Source event no longer exists - delete the synced copy
    try {
      await deleteEvent(targetAuth, targetCalendarId, record.target_event_id);
      deleteSyncedEvent(record.source_event_id, sourceAccount, targetCalendarId);
      results.deleted++;
      addSyncLog('delete', sourceAccount, `orphaned:${record.source_event_id}`, 'success', 'Deleted synced event (source was deleted)');
      console.log(`Deleted orphaned synced event: source ${record.source_event_id} from account ${sourceAccount}`);
    } catch (err) {
      // Target event may already be deleted
      if (err.code === 404 || err.message?.includes('Not Found')) {
        deleteSyncedEvent(record.source_event_id, sourceAccount, targetCalendarId);
      } else {
        console.error(`Error deleting orphaned event ${record.target_event_id}:`, err.message);
        results.errors.push({ event: `orphaned:${record.source_event_id}`, error: err.message });
      }
    }
  }
}

// Sync events from source to target
async function syncEvents(sourceEvents, targetEvents, sourceAuth, targetAuth, config, sourceAccount, results) {
  const targetAccount = sourceAccount === 1 ? 2 : 1;
  const prefix = sourceAccount === 1 ? config.prefix_1 : config.prefix_2;
  const targetCalendarId = sourceAccount === 1 ? config.calendar_id_2 : config.calendar_id_1;
  
  for (const sourceEvent of sourceEvents) {
    try {
      // Skip cancelled events
      if (sourceEvent.status === 'cancelled') {
        // Check if we have a synced copy to delete
        const syncedRecord = getSyncedEvent(sourceEvent.id, sourceAccount);
        if (syncedRecord) {
          try {
            await deleteEvent(targetAuth, targetCalendarId, syncedRecord.target_event_id);
            deleteSyncedEvent(sourceEvent.id, sourceAccount);
            results.deleted++;
            addSyncLog('delete', sourceAccount, sourceEvent.summary, 'success', 'Deleted cancelled event');
          } catch (err) {
            // Event may already be deleted
            deleteSyncedEvent(sourceEvent.id, sourceAccount);
          }
        }
        continue;
      }
      
      // Check if this event was synced FROM the other calendar or from cal3 (avoid ping-pong)
      const marker = extractSyncMarker(sourceEvent.description);
      if (marker && (marker.sourceAccount === targetAccount || marker.sourceAccount === 3)) {
        results.skipped++;
        continue;
      }
      
      // Check if we already synced this event
      const existingSyncRecord = getSyncedEvent(sourceEvent.id, sourceAccount);
      const eventHash = createEventHash(sourceEvent);
      
      if (existingSyncRecord) {
        // Event already synced - check if it changed
        if (existingSyncRecord.event_hash === eventHash) {
          results.skipped++;
          continue;
        }
        
        // Event changed - update the synced copy
        try {
          const updatedEvent = prepareEventForSync(sourceEvent, prefix, sourceAccount, config);
          await updateEvent(targetAuth, targetCalendarId, existingSyncRecord.target_event_id, updatedEvent);
          saveSyncedEvent(sourceAccount, sourceEvent.id, existingSyncRecord.target_event_id, 
            sourceAccount === 1 ? config.calendar_id_1 : config.calendar_id_2,
            targetCalendarId, eventHash);
          results.updated++;
          addSyncLog('update', sourceAccount, sourceEvent.summary, 'success', 'Updated changed event');
        } catch (err) {
          console.error(`Error updating event ${sourceEvent.id}:`, err.message);
          results.errors.push({ event: sourceEvent.summary, error: err.message });
          addSyncLog('update', sourceAccount, sourceEvent.summary, 'error', err.message);
        }
        continue;
      }
      
      // New event - check if exact synced version already exists in target
      // (catches duplicates from previous sync tools like ActivePieces)
      const existingDup = findExistingDuplicate(sourceEvent, prefix, targetEvents, config);
      if (existingDup) {
        // The synced version already exists - link them instead of creating duplicate
        console.log(`Exact synced version already exists: "${existingDup.summary}" - linking`);
        saveSyncedEvent(sourceAccount, sourceEvent.id, existingDup.id,
          sourceAccount === 1 ? config.calendar_id_1 : config.calendar_id_2,
          targetCalendarId, eventHash);
        results.skipped++;
        addSyncLog('auto_linked', sourceAccount, sourceEvent.summary, 'success', 
          `Linked to existing "${existingDup.summary}" (likely from previous sync tool)`);
        continue;
      }
      
      // Create new event in target calendar
      try {
        const newEvent = prepareEventForSync(sourceEvent, prefix, sourceAccount, config);
        const createdEvent = await createEvent(targetAuth, targetCalendarId, newEvent);
        
        saveSyncedEvent(sourceAccount, sourceEvent.id, createdEvent.id,
          sourceAccount === 1 ? config.calendar_id_1 : config.calendar_id_2,
          targetCalendarId, eventHash);
        
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

// Sync calendar 3 events one-way to a target calendar
async function syncCal3Events(sourceEvents, targetEvents, targetAuth, targetCalendarId, sourceCalendarId, config, results) {
  const prefix = config.prefix_1 || '';
  const suffix = config.suffix_3 || ' Wedding';
  
  for (const sourceEvent of sourceEvents) {
    try {
      // Skip cancelled events
      if (sourceEvent.status === 'cancelled') {
        const syncedRecord = getSyncedEvent(sourceEvent.id, 3, targetCalendarId);
        if (syncedRecord) {
          try {
            await deleteEvent(targetAuth, targetCalendarId, syncedRecord.target_event_id);
            deleteSyncedEvent(sourceEvent.id, 3, targetCalendarId);
            results.deleted++;
            addSyncLog('delete', 3, sourceEvent.summary, 'success', 'Deleted cancelled cal3 event');
          } catch (err) {
            deleteSyncedEvent(sourceEvent.id, 3, targetCalendarId);
          }
        }
        continue;
      }
      
      // Skip if this event already has a sync marker (it's a synced copy, not an original)
      const marker = extractSyncMarker(sourceEvent.description);
      if (marker) {
        continue;
      }
      
      const existingSyncRecord = getSyncedEvent(sourceEvent.id, 3, targetCalendarId);
      const eventHash = createEventHash(sourceEvent);
      
      if (existingSyncRecord) {
        // Already synced - check if changed
        if (existingSyncRecord.event_hash === eventHash) {
          results.skipped++;
          continue;
        }
        
        // Update the synced copy
        try {
          const updatedEvent = prepareEventForCal3(sourceEvent, prefix, suffix);
          await updateEvent(targetAuth, targetCalendarId, existingSyncRecord.target_event_id, updatedEvent);
          saveSyncedEvent(3, sourceEvent.id, existingSyncRecord.target_event_id,
            sourceCalendarId, targetCalendarId, eventHash);
          results.updated++;
          addSyncLog('update', 3, sourceEvent.summary, 'success', 'Updated cal3 event');
        } catch (err) {
          console.error(`Error updating cal3 event ${sourceEvent.id}:`, err.message);
          results.errors.push({ event: sourceEvent.summary, error: err.message });
          addSyncLog('update', 3, sourceEvent.summary, 'error', err.message);
        }
        continue;
      }
      
      // Check for existing duplicate in target (same prefixed+suffixed title at same time)
      const syncedTitle = prefix + (sourceEvent.summary || 'No Title') + suffix;
      const eventStart = sourceEvent.start?.dateTime || sourceEvent.start?.date;
      const existingDup = targetEvents.find(e => {
        const eStart = e.start?.dateTime || e.start?.date;
        return eStart === eventStart && e.summary?.toLowerCase() === syncedTitle.toLowerCase();
      });
      
      if (existingDup) {
        // Link to existing instead of creating duplicate
        console.log(`Cal3 event already exists in target: "${existingDup.summary}" - linking`);
        saveSyncedEvent(3, sourceEvent.id, existingDup.id,
          sourceCalendarId, targetCalendarId, eventHash);
        results.skipped++;
        addSyncLog('auto_linked', 3, sourceEvent.summary, 'success',
          `Linked to existing "${existingDup.summary}"`);
        continue;
      }
      
      // Create new event in target
      try {
        const newEvent = prepareEventForCal3(sourceEvent, prefix, suffix);
        const createdEvent = await createEvent(targetAuth, targetCalendarId, newEvent);
        
        saveSyncedEvent(3, sourceEvent.id, createdEvent.id,
          sourceCalendarId, targetCalendarId, eventHash);
        
        results.synced++;
        addSyncLog('create', 3, sourceEvent.summary, 'success', 'Created cal3 synced event');
      } catch (err) {
        console.error(`Error creating cal3 event ${sourceEvent.id}:`, err.message);
        results.errors.push({ event: sourceEvent.summary, error: err.message });
        addSyncLog('create', 3, sourceEvent.summary, 'error', err.message);
      }
    } catch (err) {
      console.error(`Error processing cal3 event:`, err);
      results.errors.push({ event: sourceEvent.summary || 'Unknown', error: err.message });
    }
  }
}

// API Routes

// Get sync configuration
syncRouter.get('/config', (req, res) => {
  const config = getSyncConfig();
  res.json(config || {});
});

// Save sync configuration
syncRouter.post('/config', (req, res) => {
  const { calendarId1, calendarId2, calendarId3, calendarName1, calendarName2, calendarName3, prefix1, prefix2, suffix3, enabled } = req.body;
  
  saveSyncConfig({
    calendarId1,
    calendarId2,
    calendarId3: calendarId3 || null,
    calendarName1,
    calendarName2,
    calendarName3: calendarName3 || null,
    prefix1: prefix1 || '[Business] ',
    prefix2: prefix2 || '[Personal] ',
    suffix3: suffix3 ?? ' Wedding',
    enabled: enabled ?? false
  });
  
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
    saveSyncConfig({
      ...config,
      calendarId1: config.calendar_id_1,
      calendarId2: config.calendar_id_2,
      calendarId3: config.calendar_id_3,
      calendarName1: config.calendar_name_1,
      calendarName2: config.calendar_name_2,
      calendarName3: config.calendar_name_3,
      prefix1: config.prefix_1,
      prefix2: config.prefix_2,
      suffix3: config.suffix_3,
      enabled: !config.enabled
    });
    res.json({ enabled: !config.enabled });
  } else {
    res.status(400).json({ error: 'No sync configuration found' });
  }
});

// Get pending duplicates for review
syncRouter.get('/duplicates', (req, res) => {
  const duplicates = getPendingDuplicates();
  res.json(duplicates);
});

// Resolve a duplicate - action can be 'sync' (create anyway), 'link' (treat as same), 'skip' (ignore permanently)
syncRouter.post('/duplicates/:id/resolve', async (req, res) => {
  const id = parseInt(req.params.id);
  const { action } = req.body; // 'sync', 'link', or 'skip'
  
  const duplicate = getPendingDuplicate(id);
  if (!duplicate) {
    return res.status(404).json({ error: 'Duplicate not found' });
  }
  
  const config = getSyncConfig();
  if (!config) {
    return res.status(400).json({ error: 'No sync configuration' });
  }
  
  try {
    if (action === 'sync') {
      // Create the event in target calendar anyway
      const sourceAccount = duplicate.source_account;
      const targetAccount = sourceAccount === 1 ? 2 : 1;
      const auth = getStoredAuthClient(targetAccount);
      const targetCalendarId = sourceAccount === 1 ? config.calendar_id_2 : config.calendar_id_1;
      const prefix = sourceAccount === 1 ? config.prefix_1 : config.prefix_2;
      
      const newEvent = prepareEventForSync(duplicate.source_event_data, prefix, sourceAccount, config);
      const createdEvent = await createEvent(auth, targetCalendarId, newEvent);
      
      const eventHash = createEventHash(duplicate.source_event_data);
      saveSyncedEvent(sourceAccount, duplicate.source_event_id, createdEvent.id,
        sourceAccount === 1 ? config.calendar_id_1 : config.calendar_id_2,
        targetCalendarId, eventHash);
      
      deletePendingDuplicate(id);
      addSyncLog('duplicate_synced', sourceAccount, duplicate.source_event_data.summary, 'success', 
        'User approved - created synced copy');
      
      res.json({ success: true, action: 'synced', eventId: createdEvent.id });
      
    } else if (action === 'link') {
      // Link the events as if they were synced (prevents future duplicate detection)
      const sourceAccount = duplicate.source_account;
      const eventHash = createEventHash(duplicate.source_event_data);
      const targetCalendarId = sourceAccount === 1 ? config.calendar_id_2 : config.calendar_id_1;
      
      saveSyncedEvent(sourceAccount, duplicate.source_event_id, duplicate.existing_event_id,
        sourceAccount === 1 ? config.calendar_id_1 : config.calendar_id_2,
        targetCalendarId, eventHash);
      
      deletePendingDuplicate(id);
      addSyncLog('duplicate_linked', sourceAccount, duplicate.source_event_data.summary, 'success', 
        `User linked to existing event "${duplicate.existing_event_data.summary}"`);
      
      res.json({ success: true, action: 'linked' });
      
    } else if (action === 'skip') {
      // Just remove from pending, don't sync
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
  const { actions } = req.body; // Array of { id, action }
  
  const results = { success: 0, failed: 0, errors: [] };
  
  for (const { id, action } of actions) {
    try {
      // Reuse the single resolve logic
      const duplicate = getPendingDuplicate(id);
      if (!duplicate) {
        results.failed++;
        results.errors.push({ id, error: 'Not found' });
        continue;
      }
      
      const config = getSyncConfig();
      
      if (action === 'sync') {
        const sourceAccount = duplicate.source_account;
        const targetAccount = sourceAccount === 1 ? 2 : 1;
        const auth = getStoredAuthClient(targetAccount);
        const targetCalendarId = sourceAccount === 1 ? config.calendar_id_2 : config.calendar_id_1;
        const prefix = sourceAccount === 1 ? config.prefix_1 : config.prefix_2;
        
        const newEvent = prepareEventForSync(duplicate.source_event_data, prefix, sourceAccount, config);
        const createdEvent = await createEvent(auth, targetCalendarId, newEvent);
        
        const eventHash = createEventHash(duplicate.source_event_data);
        saveSyncedEvent(sourceAccount, duplicate.source_event_id, createdEvent.id,
          sourceAccount === 1 ? config.calendar_id_1 : config.calendar_id_2,
          targetCalendarId, eventHash);
        
        deletePendingDuplicate(id);
        addSyncLog('duplicate_synced', sourceAccount, duplicate.source_event_data.summary, 'success', 
          'Batch approved - created synced copy');
          
      } else if (action === 'link') {
        const sourceAccount = duplicate.source_account;
        const eventHash = createEventHash(duplicate.source_event_data);
        const targetCalendarId = sourceAccount === 1 ? config.calendar_id_2 : config.calendar_id_1;
        
        saveSyncedEvent(sourceAccount, duplicate.source_event_id, duplicate.existing_event_id,
          sourceAccount === 1 ? config.calendar_id_1 : config.calendar_id_2,
          targetCalendarId, eventHash);
        
        deletePendingDuplicate(id);
        addSyncLog('duplicate_linked', sourceAccount, duplicate.source_event_data.summary, 'success', 
          'Batch linked to existing');
          
      } else if (action === 'skip') {
        updatePendingDuplicateStatus(id, 'skipped');
        addSyncLog('duplicate_skipped', duplicate.source_account, duplicate.source_event_data.summary, 'info', 
          'Batch skipped');
      }
      
      results.success++;
    } catch (error) {
      results.failed++;
      results.errors.push({ id, error: error.message });
    }
  }
  
  res.json(results);
});

// Scan for TRUE duplicates (multiple copies of same event within one calendar)
syncRouter.get('/scan-duplicates', async (req, res) => {
  const config = getSyncConfig();
  
  if (!config || !config.calendar_id_1 || !config.calendar_id_2) {
    return res.status(400).json({ error: 'Sync not configured' });
  }
  
  const auth1 = getStoredAuthClient(1);
  const auth2 = getStoredAuthClient(2);
  
  if (!auth1 || !auth2) {
    return res.status(400).json({ error: 'Both accounts must be connected' });
  }
  
  try {
    const { events: events1 } = await getEventsForSync(auth1, config.calendar_id_1);
    const { events: events2 } = await getEventsForSync(auth2, config.calendar_id_2);
    
    const duplicates1 = findDuplicatesInCalendar(events1, config, 1);
    const duplicates2 = findDuplicatesInCalendar(events2, config, 2);
    
    res.json({
      calendar1: {
        name: config.calendar_name_1,
        duplicates: duplicates1.map(d => ({
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
      },
      calendar2: {
        name: config.calendar_name_2,
        duplicates: duplicates2.map(d => ({
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
      }
    });
  } catch (error) {
    console.error('Error scanning for duplicates:', error);
    res.status(500).json({ error: 'Failed to scan for duplicates', details: error.message });
  }
});

// Batch delete multiple events
syncRouter.post('/delete-batch', async (req, res) => {
  const { events } = req.body; // Array of { accountNum, eventId }
  const config = getSyncConfig();
  
  if (!config) {
    return res.status(400).json({ error: 'Sync not configured' });
  }
  
  const results = { deleted: 0, failed: 0, errors: [] };
  
  for (const { accountNum, eventId } of events) {
    const auth = getStoredAuthClient(accountNum);
    if (!auth) {
      results.failed++;
      results.errors.push({ eventId, error: 'Account not connected' });
      continue;
    }
    
    const calendarId = accountNum === 1 ? config.calendar_id_1 : config.calendar_id_2;
    
    try {
      await deleteEvent(auth, calendarId, eventId);
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

// Delete a specific duplicate event
syncRouter.delete('/event/:accountNum/:eventId', async (req, res) => {
  const accountNum = parseInt(req.params.accountNum);
  const eventId = req.params.eventId;
  const config = getSyncConfig();
  
  if (!config) {
    return res.status(400).json({ error: 'Sync not configured' });
  }
  
  const auth = getStoredAuthClient(accountNum);
  if (!auth) {
    return res.status(400).json({ error: 'Account not connected' });
  }
  
  const calendarId = accountNum === 1 ? config.calendar_id_1 : config.calendar_id_2;
  
  try {
    await deleteEvent(auth, calendarId, eventId);
    addSyncLog('delete_duplicate', accountNum, eventId, 'success', 'User deleted duplicate event');
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting event:', error);
    res.status(500).json({ error: 'Failed to delete event', details: error.message });
  }
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
