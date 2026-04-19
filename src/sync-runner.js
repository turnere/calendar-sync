/**
 * Standalone sync runner for GitHub Actions (no web server needed).
 * 
 * Reads OAuth tokens and sync config from environment variables,
 * seeds the local SQLite database, and runs a single sync cycle.
 */
import { config } from 'dotenv';
config();

import { initDatabase, saveTokens, saveSyncConfig, getTokens, getSyncConfig, getCalendars, saveCalendar, saveSyncEnabled } from './database.js';
import { performSync } from './sync.js';

initDatabase();

// Seed tokens from environment variables (if provided)
if (process.env.ACCOUNT1_TOKENS) {
  saveTokens(1, JSON.parse(process.env.ACCOUNT1_TOKENS), process.env.ACCOUNT1_EMAIL || '');
}
if (process.env.ACCOUNT2_TOKENS) {
  saveTokens(2, JSON.parse(process.env.ACCOUNT2_TOKENS), process.env.ACCOUNT2_EMAIL || '');
}

// Seed sync config from environment variables (backward compatible)
if (process.env.CALENDAR_ID_1 && process.env.CALENDAR_ID_2) {
  // Legacy format: seed into old sync_config (triggers migration on next init)
  saveSyncConfig({
    calendarId1: process.env.CALENDAR_ID_1,
    calendarId2: process.env.CALENDAR_ID_2,
    calendarId3: process.env.CALENDAR_ID_3 || null,
    calendarName1: process.env.CALENDAR_NAME_1 || 'Calendar 1',
    calendarName2: process.env.CALENDAR_NAME_2 || 'Calendar 2',
    calendarName3: process.env.CALENDAR_NAME_3 || null,
    prefix1: process.env.PREFIX_1 || '[Business] ',
    prefix2: process.env.PREFIX_2 || '[Personal] ',
    suffix3: process.env.SUFFIX_3 || ' Wedding',
    enabled: true
  });
  
  // Also seed into calendars table if empty
  const existingCals = getCalendars();
  if (existingCals.length === 0) {
    saveCalendar({
      accountNum: 1,
      calendarId: process.env.CALENDAR_ID_1,
      calendarName: process.env.CALENDAR_NAME_1 || 'Calendar 1',
      prefix: process.env.PREFIX_1 || '[Business] ',
      syncMode: 'bidirectional'
    });
    saveCalendar({
      accountNum: 2,
      calendarId: process.env.CALENDAR_ID_2,
      calendarName: process.env.CALENDAR_NAME_2 || 'Calendar 2',
      prefix: process.env.PREFIX_2 || '[Personal] ',
      syncMode: 'bidirectional'
    });
    if (process.env.CALENDAR_ID_3) {
      saveCalendar({
        accountNum: 1,
        calendarId: process.env.CALENDAR_ID_3,
        calendarName: process.env.CALENDAR_NAME_3 || 'Calendar 3',
        prefix: process.env.PREFIX_1 || '[Business] ',
        suffix: process.env.SUFFIX_3 || ' Wedding',
        syncMode: 'one-way'
      });
    }
  }
  
  saveSyncEnabled(true);
}

// Validate that we have everything needed
const tokens1 = getTokens(1);
const tokens2 = getTokens(2);
const syncConfig = getSyncConfig();
const calendars = getCalendars();

if (!tokens1 || !tokens2) {
  console.error('ERROR: Missing OAuth tokens. Set ACCOUNT1_TOKENS and ACCOUNT2_TOKENS.');
  console.error('  Account 1 tokens:', tokens1 ? 'OK' : 'MISSING');
  console.error('  Account 2 tokens:', tokens2 ? 'OK' : 'MISSING');
  process.exit(1);
}

if (calendars.length < 2) {
  console.error('ERROR: Need at least 2 calendars configured.');
  process.exit(1);
}

console.log('Starting calendar sync...');
for (const cal of calendars) {
  console.log(`  ${cal.calendar_name} (Account ${cal.account_num}, ${cal.sync_mode})`);
}

const result = await performSync();
console.log('Sync result:', JSON.stringify(result, null, 2));

if (!result.success) {
  console.error('Sync failed:', result.message);
  process.exit(1);
}
