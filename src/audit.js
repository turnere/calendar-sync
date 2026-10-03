/**
 * Sync audit — independently compares each source calendar against its sync targets
 * and reports events that should be there but aren't. If ANTHROPIC_API_KEY is set,
 * Claude turns the raw discrepancies + recent sync errors into a short diagnosis.
 */
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getStoredAuthClient } from './auth.js';
import { getEventsForSync } from './calendar.js';
import { getEventsFromIcsUrl } from './ics-source.js';
import { filterExcludedEvents, extractSyncMarker, findExistingDuplicate } from './sync.js';
import { notifyAuditIssues, notifyAuditClean } from './notify.js';
import {
  getSyncConfig,
  getEnabledCalendars,
  getSyncedEvent,
  deleteSyncedEvent,
  isPendingDuplicate,
  getSyncLogs
} from './database.js';

const MODEL = 'claude-sonnet-5-5';
const MAX_LISTED = 40;

export const auditRouter = express.Router();

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

async function fetchCalendarEvents(cal, auths) {
  let events;
  if (cal.source_type === 'ics') {
    events = await getEventsFromIcsUrl(cal.ics_url);
  } else {
    ({ events } = await getEventsForSync(auths[cal.account_num], cal.calendar_id));
  }
  const live = events.filter(e => e.status !== 'cancelled');
  const kept = filterExcludedEvents(live, cal.exclude_keywords);
  return { events: kept, excluded: live.length - kept.length };
}

const startOf = e => e.start?.dateTime || e.start?.date || '';

// Work out whether one source event is represented on the target calendar.
// Returns null when it is, otherwise a { reason } describing why it is missing.
function checkEvent(event, sourceCal, targetCal, targetById, targetEvents, allCalendars, oneWay) {
  const marker = extractSyncMarker(event.description);
  // Synced copies are never re-synced (bidirectional: only back to their origin account)
  if (marker && (oneWay || marker.sourceAccount === targetCal.account_num)) return null;

  const record = getSyncedEvent(event.id, sourceCal.account_num, targetCal.calendar_id);
  if (record) {
    if (targetById.has(record.target_event_id)) return null;
    // The sync believes it already copied this, so it will NOT recreate it on its own
    return { reason: 'copy_deleted_from_target', record };
  }

  if (findExistingDuplicate(event, sourceCal, targetEvents, allCalendars)) return null;
  if (isPendingDuplicate(event.id, sourceCal.account_num)) return { reason: 'awaiting_duplicate_review' };
  return { reason: 'never_synced' };
}

export async function runAudit({ repair = false } = {}) {
  const config = getSyncConfig();
  const allCalendars = getEnabledCalendars();
  if (allCalendars.length < 2) throw new Error('Need at least 2 enabled calendars');

  const auths = {};
  for (const acct of new Set(allCalendars.filter(c => c.source_type !== 'ics').map(c => c.account_num))) {
    auths[acct] = getStoredAuthClient(acct);
    if (!auths[acct]) throw new Error(`Account ${acct} not connected`);
  }

  const fetched = {};
  for (const cal of allCalendars) fetched[cal.id] = await fetchCalendarEvents(cal, auths);

  // Same source -> target pairings performSync uses
  const biDir = allCalendars.filter(c => c.sync_mode === 'bidirectional');
  const oneWay = allCalendars.filter(c => c.sync_mode === 'one-way');
  const pairs = [];
  for (const a of biDir) {
    for (const b of biDir) {
      if (a.id !== b.id && a.account_num !== b.account_num) pairs.push([a, b, false]);
    }
  }
  for (const s of oneWay) {
    for (const t of biDir) if (t.calendar_id !== s.calendar_id) pairs.push([s, t, true]);
  }

  const report = { checkedAt: new Date().toISOString(), lastSync: config?.last_sync || null, pairs: [], repaired: 0 };

  for (const [src, tgt, isOneWay] of pairs) {
    const { events: srcEvents, excluded } = fetched[src.id];
    const { events: tgtEvents } = fetched[tgt.id];
    const targetById = new Map(tgtEvents.map(e => [e.id, e]));

    const missing = [];
    let expected = 0;
    for (const event of srcEvents) {
      const marker = extractSyncMarker(event.description);
      if (marker && (isOneWay || marker.sourceAccount === tgt.account_num)) continue;
      expected++;
      const problem = checkEvent(event, src, tgt, targetById, tgtEvents, allCalendars, isOneWay);
      if (!problem) continue;
      missing.push({ title: event.summary || '(no title)', start: startOf(event), reason: problem.reason });
      if (repair && problem.reason === 'copy_deleted_from_target') {
        // Dropping the stale link lets the next sync recreate the copy
        deleteSyncedEvent(event.id, src.account_num, tgt.calendar_id);
        report.repaired++;
      }
    }

    report.pairs.push({
      source: src.calendar_name,
      target: tgt.calendar_name,
      sourceEventCount: srcEvents.length,
      excludedByKeyword: excluded,
      expectedOnTarget: expected,
      presentOnTarget: expected - missing.length,
      missing
    });
  }

  report.totalMissing = report.pairs.reduce((n, p) => n + p.missing.length, 0);
  report.recentErrors = getSyncLogs(200)
    .filter(l => l.status === 'error')
    .slice(0, 15)
    .map(l => ({ at: l.created_at, action: l.action, event: l.event_title, message: l.message }));

  report.analysis = report.totalMissing > 0 || report.recentErrors.length > 0
    ? await analyzeWithClaude(report)
    : null;
  return report;
}

async function analyzeWithClaude(report) {
  const anthropic = getClient();
  if (!anthropic) return null;

  const trimmed = {
    ...report,
    analysis: undefined,
    pairs: report.pairs.map(p => ({
      ...p,
      missing: p.missing.slice(0, MAX_LISTED),
      missingNotShown: Math.max(0, p.missing.length - MAX_LISTED)
    }))
  };

  const prompt = `You are auditing a two-way Google Calendar sync tool. Below is a JSON audit comparing each source calendar to its sync target. "missing" lists source events with no matching copy on the target.

Reasons: never_synced = no sync record and no matching copy exists; copy_deleted_from_target = the sync recorded a copy but it has since vanished from the target (the sync will not recreate it on its own); awaiting_duplicate_review = held back as a possible duplicate pending user review.

Write a brief plain-text diagnosis (under 200 words): whether the sync looks healthy, the likely cause of any missing events (look for patterns in dates, titles, and the recent errors), and what the user should do. If everything is fine, say so in one or two sentences.

${JSON.stringify(trimmed)}`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });
    return response.content.find(b => b.type === 'text')?.text || null;
  } catch (error) {
    console.error('AI audit analysis failed:', error.message);
    return null;
  }
}

function formatReport(report) {
  const lines = [`Audit at ${report.checkedAt} (last sync: ${report.lastSync || 'never'})`];
  for (const p of report.pairs) {
    lines.push(`\n${p.source} -> ${p.target}: ${p.presentOnTarget}/${p.expectedOnTarget} present` +
      (p.excludedByKeyword ? ` (${p.excludedByKeyword} excluded by keyword)` : ''));
    for (const m of p.missing) lines.push(`  MISSING [${m.reason}] ${m.start}  ${m.title}`);
  }
  if (report.repaired) lines.push(`\nRepaired ${report.repaired} stale link(s); run a sync to recreate them.`);
  if (report.analysis) lines.push(`\nClaude's analysis:\n${report.analysis}`);
  return lines.join('\n');
}

// GET /api/audit            -> JSON report
// GET /api/audit?repair=1   -> also clear stale links so the next sync recreates deleted copies
// GET /api/audit?format=text -> readable text
auditRouter.get('/', async (req, res) => {
  try {
    const report = await runAudit({ repair: req.query.repair === '1' });
    if (req.query.format === 'text') return res.type('text/plain').send(formatReport(report));
    res.json(report);
  } catch (error) {
    console.error('Audit failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Daily background audit; raises a Habitica todo when events are missing.
export function startAuditScheduler() {
  const hours = parseInt(process.env.AUDIT_INTERVAL_HOURS) || 24;
  console.log(`Starting audit scheduler (every ${hours}h)`);

  const run = async () => {
    try {
      const report = await runAudit();
      console.log(`Audit: ${report.totalMissing} missing event(s)`);
      if (report.totalMissing > 0) {
        await notifyAuditIssues(report.analysis || formatReport(report));
      } else {
        await notifyAuditClean();
      }
    } catch (error) {
      console.error('Scheduled audit failed:', error.message);
    }
  };

  // First run a few minutes after startup, once the initial sync has finished
  setTimeout(run, 5 * 60 * 1000);
  setInterval(run, hours * 60 * 60 * 1000);
}

export { formatReport };
