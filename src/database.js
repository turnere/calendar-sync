import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import crypto from 'crypto';

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
      calendar_id_3 TEXT,
      calendar_name_1 TEXT,
      calendar_name_2 TEXT,
      calendar_name_3 TEXT,
      prefix_1 TEXT DEFAULT '[Business] ',
      prefix_2 TEXT DEFAULT '[Personal] ',
      suffix_3 TEXT DEFAULT ' Wedding',
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
      UNIQUE(source_event_id, source_account, target_calendar_id)
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
  
  // Migrations for existing databases
  const configColumns = db.pragma("table_info('sync_config')").map(c => c.name);
  if (!configColumns.includes('calendar_id_3')) {
    db.exec("ALTER TABLE sync_config ADD COLUMN calendar_id_3 TEXT");
    db.exec("ALTER TABLE sync_config ADD COLUMN calendar_name_3 TEXT");
    db.exec("ALTER TABLE sync_config ADD COLUMN suffix_3 TEXT DEFAULT ' Wedding'");
    console.log('Added calendar 3 columns to sync_config');
  }

  // Migrate synced_events unique constraint for multi-target sync
  const indexes = db.pragma("index_list('synced_events')");
  const needsMigration = indexes.some(idx => {
    if (!idx.unique) return false;
    const cols = db.pragma(`index_info('${idx.name}')`).map(c => c.name);
    return cols.length === 2 && cols.includes('source_event_id') && cols.includes('source_account');
  });
  if (needsMigration) {
    db.exec(`
      CREATE TABLE synced_events_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_account INTEGER NOT NULL,
        source_event_id TEXT NOT NULL,
        target_event_id TEXT NOT NULL,
        source_calendar_id TEXT NOT NULL,
        target_calendar_id TEXT NOT NULL,
        event_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_event_id, source_account, target_calendar_id)
      );
      INSERT OR IGNORE INTO synced_events_new SELECT * FROM synced_events;
      DROP TABLE synced_events;
      ALTER TABLE synced_events_new RENAME TO synced_events;
    `);
    console.log('Migrated synced_events for multi-target sync');
  }

  // --- New: flexible multi-calendar support ---

  // Calendars table: allows unlimited calendars from either account
  db.exec(`
    CREATE TABLE IF NOT EXISTS calendars (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_num INTEGER NOT NULL,
      calendar_id TEXT NOT NULL,
      calendar_name TEXT,
      prefix TEXT DEFAULT '',
      suffix TEXT DEFAULT '',
      sync_mode TEXT DEFAULT 'bidirectional',
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(calendar_id)
    );
  `);

  // Add ics_token column to sync_config if missing
  if (!configColumns.includes('ics_token')) {
    db.exec("ALTER TABLE sync_config ADD COLUMN ics_token TEXT");
  }

  // Ensure sync_config row exists with an ICS token
  const scRow = db.prepare('SELECT * FROM sync_config WHERE id = 1').get();
  if (scRow && !scRow.ics_token) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('UPDATE sync_config SET ics_token = ? WHERE id = 1').run(token);
  } else if (!scRow) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sync_config (id, ics_token) VALUES (1, ?)').run(token);
  }

  // Migrate old sync_config calendar data → calendars table
  const calCount = db.prepare('SELECT COUNT(*) as count FROM calendars').get();
  if (calCount.count === 0) {
    const oldCfg = db.prepare('SELECT * FROM sync_config WHERE id = 1').get();
    if (oldCfg?.calendar_id_1) {
      db.prepare('INSERT OR IGNORE INTO calendars (account_num, calendar_id, calendar_name, prefix, sync_mode) VALUES (?, ?, ?, ?, ?)')
        .run(1, oldCfg.calendar_id_1, oldCfg.calendar_name_1 || 'Calendar 1', oldCfg.prefix_1 || '[Business] ', 'bidirectional');
    }
    if (oldCfg?.calendar_id_2) {
      db.prepare('INSERT OR IGNORE INTO calendars (account_num, calendar_id, calendar_name, prefix, sync_mode) VALUES (?, ?, ?, ?, ?)')
        .run(2, oldCfg.calendar_id_2, oldCfg.calendar_name_2 || 'Calendar 2', oldCfg.prefix_2 || '[Personal] ', 'bidirectional');
    }
    if (oldCfg?.calendar_id_3) {
      db.prepare('INSERT OR IGNORE INTO calendars (account_num, calendar_id, calendar_name, prefix, suffix, sync_mode) VALUES (?, ?, ?, ?, ?, ?)')
        .run(1, oldCfg.calendar_id_3, oldCfg.calendar_name_3 || 'Calendar 3', oldCfg.prefix_1 || '[Business] ', oldCfg.suffix_3 || ' Wedding', 'one-way');
    }
    if (calCount.count === 0) console.log('Migrated calendar config to calendars table');
  }

  // Fix old source_account=3 records (cal3 was always on account 1)
  db.prepare('UPDATE synced_events SET source_account = 1 WHERE source_account = 3').run();

  // Migrate synced_events unique constraint to use source_calendar_id
  const seIndexes2 = db.pragma("index_list('synced_events')");
  const needsCalIdMigration = seIndexes2.some(idx => {
    if (!idx.unique) return false;
    const cols = db.pragma(`index_info('${idx.name}')`).map(c => c.name);
    return cols.includes('source_account') && cols.includes('source_event_id') && cols.includes('target_calendar_id') && !cols.includes('source_calendar_id');
  });
  if (needsCalIdMigration) {
    db.exec(`
      CREATE TABLE synced_events_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_account INTEGER NOT NULL,
        source_event_id TEXT NOT NULL,
        target_event_id TEXT NOT NULL,
        source_calendar_id TEXT NOT NULL,
        target_calendar_id TEXT NOT NULL,
        event_hash TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(source_event_id, source_calendar_id, target_calendar_id)
      );
      INSERT OR IGNORE INTO synced_events_v3 SELECT * FROM synced_events;
      DROP TABLE synced_events;
      ALTER TABLE synced_events_v3 RENAME TO synced_events;
    `);
    console.log('Migrated synced_events unique constraint to source_calendar_id');
  }

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
    (id, calendar_id_1, calendar_id_2, calendar_id_3, calendar_name_1, calendar_name_2, calendar_name_3, prefix_1, prefix_2, suffix_3, enabled, updated_at)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `);
  stmt.run(
    config.calendarId1,
    config.calendarId2,
    config.calendarId3 || null,
    config.calendarName1,
    config.calendarName2,
    config.calendarName3 || null,
    config.prefix1 || '[Business] ',
    config.prefix2 || '[Personal] ',
    config.suffix3 ?? ' Wedding',
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

export function getSyncedEvent(sourceEventId, sourceAccount, targetCalendarId = null) {
  if (targetCalendarId) {
    const stmt = db.prepare('SELECT * FROM synced_events WHERE source_event_id = ? AND source_account = ? AND target_calendar_id = ?');
    return stmt.get(sourceEventId, sourceAccount, targetCalendarId);
  }
  const stmt = db.prepare('SELECT * FROM synced_events WHERE source_event_id = ? AND source_account = ?');
  return stmt.get(sourceEventId, sourceAccount);
}

export function getSyncedEventByTargetId(targetEventId) {
  const stmt = db.prepare('SELECT * FROM synced_events WHERE target_event_id = ?');
  return stmt.get(targetEventId);
}

export function deleteSyncedEvent(sourceEventId, sourceAccount, targetCalendarId = null) {
  if (targetCalendarId) {
    const stmt = db.prepare('DELETE FROM synced_events WHERE source_event_id = ? AND source_account = ? AND target_calendar_id = ?');
    stmt.run(sourceEventId, sourceAccount, targetCalendarId);
  } else {
    const stmt = db.prepare('DELETE FROM synced_events WHERE source_event_id = ? AND source_account = ?');
    stmt.run(sourceEventId, sourceAccount);
  }
}

export function getAllSyncedEvents() {
  const stmt = db.prepare('SELECT * FROM synced_events ORDER BY created_at DESC');
  return stmt.all();
}

export function getSyncedEventsByAccount(sourceAccount) {
  const stmt = db.prepare('SELECT * FROM synced_events WHERE source_account = ?');
  return stmt.all(sourceAccount);
}

export function getSyncedEventsByAccountAndTarget(sourceAccount, targetCalendarId) {
  const stmt = db.prepare('SELECT * FROM synced_events WHERE source_account = ? AND target_calendar_id = ?');
  return stmt.all(sourceAccount, targetCalendarId);
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

// --- Calendars management ---

export function getCalendars() {
  return db.prepare('SELECT * FROM calendars ORDER BY account_num, id').all();
}

export function getEnabledCalendars() {
  return db.prepare('SELECT * FROM calendars WHERE enabled = 1 ORDER BY account_num, id').all();
}

export function getCalendarsByAccount(accountNum) {
  return db.prepare('SELECT * FROM calendars WHERE account_num = ? ORDER BY id').all(accountNum);
}

export function getCalendarById(id) {
  return db.prepare('SELECT * FROM calendars WHERE id = ?').get(id);
}

export function saveCalendar(cal) {
  const stmt = db.prepare(`
    INSERT INTO calendars (account_num, calendar_id, calendar_name, prefix, suffix, sync_mode, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    cal.accountNum, cal.calendarId, cal.calendarName || '',
    cal.prefix || '', cal.suffix || '', cal.syncMode || 'bidirectional',
    cal.enabled !== false ? 1 : 0
  );
  return result.lastInsertRowid;
}

export function updateCalendar(id, cal) {
  const stmt = db.prepare(`
    UPDATE calendars SET calendar_name = ?, prefix = ?, suffix = ?, sync_mode = ?, enabled = ?
    WHERE id = ?
  `);
  stmt.run(cal.calendarName || '', cal.prefix || '', cal.suffix || '', cal.syncMode || 'bidirectional', cal.enabled !== false ? 1 : 0, id);
}

export function removeCalendar(id) {
  // Also clean up synced_events referencing this calendar
  const cal = db.prepare('SELECT * FROM calendars WHERE id = ?').get(id);
  if (cal) {
    db.prepare('DELETE FROM synced_events WHERE source_calendar_id = ? OR target_calendar_id = ?').run(cal.calendar_id, cal.calendar_id);
  }
  db.prepare('DELETE FROM calendars WHERE id = ?').run(id);
}

export function getIcsToken() {
  const config = db.prepare('SELECT ics_token FROM sync_config WHERE id = 1').get();
  return config?.ics_token;
}

export function saveSyncEnabled(enabled) {
  const existing = db.prepare('SELECT id FROM sync_config WHERE id = 1').get();
  if (existing) {
    db.prepare('UPDATE sync_config SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(enabled ? 1 : 0);
  } else {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sync_config (id, enabled, ics_token, updated_at) VALUES (1, ?, ?, CURRENT_TIMESTAMP)').run(enabled ? 1 : 0, token);
  }
}

export default db;
