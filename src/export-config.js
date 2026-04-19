/**
 * Export tokens and config from the local database for GitHub Actions secrets.
 * 
 * Run the web server locally first to complete OAuth setup, then run:
 *   node src/export-config.js
 * 
 * Copy the output values into your GitHub repository secrets.
 */
import { config } from 'dotenv';
config();

import { initDatabase, getTokens, getAccountInfo, getSyncConfig, getCalendars } from './database.js';

initDatabase();

const account1 = getAccountInfo(1);
const account2 = getAccountInfo(2);
const tokens1 = getTokens(1);
const tokens2 = getTokens(2);
const syncConfig = getSyncConfig();

if (!tokens1 || !tokens2) {
  console.error('\n⚠  Not all accounts are connected.');
  console.error('   Run the web server first (npm start) and connect both Google accounts.\n');
  if (!tokens1) console.error('   ✗ Account 1: not connected');
  if (!tokens2) console.error('   ✗ Account 2: not connected');
  console.log('');
  process.exit(1);
}

console.log('\n=== GitHub Repository Secrets ===');
console.log('Go to: Settings > Secrets and variables > Actions > New repository secret\n');

console.log('--- Required secrets ---\n');

console.log(`GOOGLE_CLIENT_ID_1`);
console.log(`  Value: ${process.env.GOOGLE_CLIENT_ID_1 || '(set from your Google Cloud Console)'}\n`);

console.log(`GOOGLE_CLIENT_SECRET_1`);
console.log(`  Value: ${process.env.GOOGLE_CLIENT_SECRET_1 || '(set from your Google Cloud Console)'}\n`);

console.log(`GOOGLE_CLIENT_ID_2`);
console.log(`  Value: ${process.env.GOOGLE_CLIENT_ID_2 || process.env.GOOGLE_CLIENT_ID_1 || '(set from your Google Cloud Console)'}\n`);

console.log(`GOOGLE_CLIENT_SECRET_2`);
console.log(`  Value: ${process.env.GOOGLE_CLIENT_SECRET_2 || process.env.GOOGLE_CLIENT_SECRET_1 || '(set from your Google Cloud Console)'}\n`);

console.log(`ACCOUNT1_TOKENS`);
console.log(`  Value: ${JSON.stringify(tokens1)}\n`);

console.log(`ACCOUNT1_EMAIL`);
console.log(`  Value: ${account1?.email || ''}\n`);

console.log(`ACCOUNT2_TOKENS`);
console.log(`  Value: ${JSON.stringify(tokens2)}\n`);

console.log(`ACCOUNT2_EMAIL`);
console.log(`  Value: ${account2?.email || ''}\n`);

if (syncConfig) {
  console.log(`CALENDAR_ID_1`);
  console.log(`  Value: ${syncConfig.calendar_id_1}\n`);

  console.log(`CALENDAR_ID_2`);
  console.log(`  Value: ${syncConfig.calendar_id_2}\n`);

  console.log('--- Optional secrets (have defaults) ---\n');

  console.log(`CALENDAR_NAME_1`);
  console.log(`  Value: ${syncConfig.calendar_name_1 || 'Calendar 1'}\n`);

  console.log(`CALENDAR_NAME_2`);
  console.log(`  Value: ${syncConfig.calendar_name_2 || 'Calendar 2'}\n`);

  console.log(`PREFIX_1`);
  console.log(`  Value: ${syncConfig.prefix_1 || '[Business] '}\n`);

  console.log(`PREFIX_2`);
  console.log(`  Value: ${syncConfig.prefix_2 || '[Personal] '}\n`);
} else {
  console.log('⚠  No sync config found. Configure calendars in the web UI first.\n');
}

const calendars = getCalendars();
if (calendars.length > 0) {
  console.log('--- Configured Calendars ---\n');
  for (const cal of calendars) {
    console.log(`  ${cal.calendar_name} (Account ${cal.account_num}, ${cal.sync_mode})`);
    console.log(`    ID: ${cal.calendar_id}`);
    console.log(`    Prefix: "${cal.prefix}" Suffix: "${cal.suffix}"\n`);
  }
}

console.log('=================================\n');
