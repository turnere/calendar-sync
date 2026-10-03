/**
 * One-off audit from the command line: npm run audit [-- --repair]
 * Uses the local SQLite database, so run it where the real data lives.
 */
import { config } from 'dotenv';
config();

import { initDatabase } from './database.js';
import { runAudit, formatReport } from './audit.js';

initDatabase();

const report = await runAudit({ repair: process.argv.includes('--repair') });
console.log(formatReport(report));
process.exit(report.totalMissing > 0 ? 1 : 0);
