/**
 * Standalone sync runner for GitHub Actions (no web server needed).
 * 
 * Reads OAuth tokens and sync config from environment variables,
 * seeds the local SQLite database, and runs a single sync cycle.
 */
import { config } from 'dotenv';
config();

import { initDatabase, saveTokens, saveSyncConfig, getTokens, getSyncConfig } from './database.js';
import { performSync } from './sync.js';

initDatabase();

// Seed tokens from environment variables (if provided)
if (process.env.ACCOUNT1_TOKENS) {
  saveTokens(1, JSON.parse(process.env.ACCOUNT1_TOKENS), process.env.ACCOUNT1_EMAIL || '');
}
if (process.env.ACCOUNT2_TOKENS) {
  saveTokens(2, JSON.parse(process.env.ACCOUNT2_TOKENS), process.env.ACCOUNT2_EMAIL || '');
}

// Seed sync config from environment variables (if provided)
if (process.env.CALENDAR_ID_1 && process.env.CALENDAR_ID_2) {
  saveSyncConfig({
    calendarId1: process.env.CALENDAR_ID_1,
    calendarId2: process.env.CALENDAR_ID_2,
    calendarName1: process.env.CALENDAR_NAME_1 || 'Calendar 1',
    calendarName2: process.env.CALENDAR_NAME_2 || 'Calendar 2',
    prefix1: process.env.PREFIX_1 || '[Business] ',
    prefix2: process.env.PREFIX_2 || '[Personal] ',
    enabled: true
  });
}

// Validate that we have everything needed
const tokens1 = getTokens(1);
const tokens2 = getTokens(2);
const syncConfig = getSyncConfig();

if (!tokens1 || !tokens2) {
  console.error('ERROR: Missing OAuth tokens. Set ACCOUNT1_TOKENS and ACCOUNT2_TOKENS.');
  console.error('  Account 1 tokens:', tokens1 ? 'OK' : 'MISSING');
  console.error('  Account 2 tokens:', tokens2 ? 'OK' : 'MISSING');
  process.exit(1);
}

if (!syncConfig || !syncConfig.calendar_id_1 || !syncConfig.calendar_id_2) {
  console.error('ERROR: Missing sync config. Set CALENDAR_ID_1 and CALENDAR_ID_2.');
  process.exit(1);
}

console.log('Starting calendar sync...');
console.log(`  Calendar 1: ${syncConfig.calendar_name_1} (${syncConfig.calendar_id_1})`);
console.log(`  Calendar 2: ${syncConfig.calendar_name_2} (${syncConfig.calendar_id_2})`);

const result = await performSync();
console.log('Sync result:', JSON.stringify(result, null, 2));

if (!result.success) {
  console.error('Sync failed:', result.message);
  process.exit(1);
}
