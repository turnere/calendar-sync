import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Use DATA_DIR env variable for persistent storage (e.g., Render disk), or fallback to local data folder
const dataDir = process.env.DATA_DIR || join(__dirname, '../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(join(dataDir, 'calendar-sync.db'));

export function initDatabase() {
  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      tokens TEXT NOT NULL,
      email TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS sync_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      calendar_id_1 TEXT,
      calendar_id_2 TEXT,
      calendar_name_1 TEXT,
      calendar_name_2 TEXT,
      prefix_1 TEXT DEFAULT '[Business] ',
      prefix_2 TEXT DEFAULT '[Personal] ',
      enabled INTEGER DEFAULT 0,
      last_sync DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS synced_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_account INTEGER NOT NULL,
      source_event_id TEXT NOT NULL,
      target_event_id TEXT NOT NULL,
      source_calendar_id TEXT NOT NULL,
      target_calendar_id TEXT NOT NULL,
      event_hash TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_event_id, source_account)
    );
    
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      source_account INTEGER,
      event_title TEXT,
      status TEXT,
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE TABLE IF NOT EXISTS pending_duplicates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_account INTEGER NOT NULL,
      source_event_id TEXT NOT NULL,
      source_event_data TEXT NOT NULL,
      existing_event_id TEXT NOT NULL,
      existing_event_data TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_event_id, source_account)
    );
  `);
  
  console.log('Database initialized');
}

// Token management
export function saveTokens(accountNum, tokens, email) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO accounts (id, tokens, email, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `);
  stmt.run(accountNum, JSON.stringify(tokens), email);
}

export function getTokens(accountNum) {
  const stmt = db.prepare('SELECT tokens FROM accounts WHERE id = ?');
  const row = stmt.get(accountNum);
  return row ? JSON.parse(row.tokens) : null;
}

export function getAccountInfo(accountNum) {
  const stmt = db.prepare('SELECT * FROM accounts WHERE id = ?');
  return stmt.get(accountNum);
}

// Sync config management
export function saveSyncConfig(config) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO sync_config 
    (id, calendar_id_1, calendar_id_2, calendar_name_1, calendar_name_2, prefix_1, prefix_2, enabled, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  stmt.run(
    config.calendarId1,
    config.calendarId2,
    config.calendarName1,
    config.calendarName2,
    config.prefix1 || '[Business] ',
    config.prefix2 || '[Personal] ',
    config.enabled ? 1 : 0
  );
}

export function getSyncConfig() {
  const stmt = db.prepare('SELECT * FROM sync_config WHERE id = 1');
  return stmt.get();
}

export function updateLastSync() {
  const stmt = db.prepare('UPDATE sync_config SET last_sync = CURRENT_TIMESTAMP WHERE id = 1');
  stmt.run();
}

// Synced events management
export function saveSyncedEvent(sourceAccount, sourceEventId, targetEventId, sourceCalendarId, targetCalendarId, eventHash) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO synced_events 
    (source_account, source_event_id, target_event_id, source_calendar_id, target_calendar_id, event_hash, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  stmt.run(sourceAccount, sourceEventId, targetEventId, sourceCalendarId, targetCalendarId, eventHash);
}

export function getSyncedEvent(sourceEventId, sourceAccount) {
  const stmt = db.prepare('SELECT * FROM synced_events WHERE source_event_id = ? AND source_account = ?');
  return stmt.get(sourceEventId, sourceAccount);
}

export function getSyncedEventByTargetId(targetEventId) {
  const stmt = db.prepare('SELECT * FROM synced_events WHERE target_event_id = ?');
  return stmt.get(targetEventId);
}

export function deleteSyncedEvent(sourceEventId, sourceAccount) {
  const stmt = db.prepare('DELETE FROM synced_events WHERE source_event_id = ? AND source_account = ?');
  stmt.run(sourceEventId, sourceAccount);
}

export function getAllSyncedEvents() {
  const stmt = db.prepare('SELECT * FROM synced_events ORDER BY created_at DESC');
  return stmt.all();
}

export function getSyncedEventsByAccount(sourceAccount) {
  const stmt = db.prepare('SELECT * FROM synced_events WHERE source_account = ?');
  return stmt.all(sourceAccount);
}

// Sync log management
export function addSyncLog(action, sourceAccount, eventTitle, status, message) {
  const stmt = db.prepare(`
    INSERT INTO sync_log (action, source_account, event_title, status, message)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(action, sourceAccount, eventTitle, status, message);
}

export function getSyncLogs(limit = 100) {
  const stmt = db.prepare('SELECT * FROM sync_log ORDER BY created_at DESC LIMIT ?');
  return stmt.all(limit);
}

export function clearSyncLogs() {
  const stmt = db.prepare('DELETE FROM sync_log');
  stmt.run();
}

// Pending duplicates management
export function savePendingDuplicate(sourceAccount, sourceEventId, sourceEventData, existingEventId, existingEventData) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO pending_duplicates 
    (source_account, source_event_id, source_event_data, existing_event_id, existing_event_data, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);
  stmt.run(sourceAccount, sourceEventId, JSON.stringify(sourceEventData), existingEventId, JSON.stringify(existingEventData));
}

export function getPendingDuplicates() {
  const stmt = db.prepare('SELECT * FROM pending_duplicates WHERE status = ? ORDER BY created_at DESC');
  const rows = stmt.all('pending');
  return rows.map(row => ({
    ...row,
    source_event_data: JSON.parse(row.source_event_data),
    existing_event_data: JSON.parse(row.existing_event_data)
  }));
}

export function getPendingDuplicate(id) {
  const stmt = db.prepare('SELECT * FROM pending_duplicates WHERE id = ?');
  const row = stmt.get(id);
  if (row) {
    row.source_event_data = JSON.parse(row.source_event_data);
    row.existing_event_data = JSON.parse(row.existing_event_data);
  }
  return row;
}

export function updatePendingDuplicateStatus(id, status) {
  const stmt = db.prepare('UPDATE pending_duplicates SET status = ? WHERE id = ?');
  stmt.run(status, id);
}

export function deletePendingDuplicate(id) {
  const stmt = db.prepare('DELETE FROM pending_duplicates WHERE id = ?');
  stmt.run(id);
}

export function clearResolvedDuplicates() {
  const stmt = db.prepare('DELETE FROM pending_duplicates WHERE status != ?');
  stmt.run('pending');
}

export function isPendingDuplicate(sourceEventId, sourceAccount) {
  const stmt = db.prepare('SELECT id FROM pending_duplicates WHERE source_event_id = ? AND source_account = ?');
  return !!stmt.get(sourceEventId, sourceAccount);
}

export default db;
