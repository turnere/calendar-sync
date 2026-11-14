import express from 'express';
import crypto from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { getCombinedEvents } from './sync.js';
import { getIcsToken } from './database.js';
import { NEAR_MS, startMs, toItem, findCandidates, applyGroups } from './agenda-merge.js';

// Read-only, de-duplicated agenda across every enabled calendar, for the phone
// view (public/agenda.html) and any home-screen widget. Nothing is written back
// to Google - this only decides what to *show*.

const MODEL = 'claude-opus-5-5';
const RESPONSE_TTL_MS = 2 * 60 * 1000;    // reuse a built agenda for 2 minutes
const MAX_AI_CACHE = 100;

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}


const GROUPS_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' }
        },
        required: ['keys', 'reason'],
        additionalProperties: false
      }
    }
  },
  required: ['groups'],
  additionalProperties: false
};

// Decisions keyed by a hash of the candidate set, so an unchanged calendar
// never triggers a second API call.
const aiCache = new Map();

async function askClaudeForGroups(candidates) {
  const anthropic = getClient();
  if (!anthropic) return { status: 'off', groups: [] };

  // Short keys keep the prompt small and stop the model mangling long Google IDs.
  const keyed = candidates.map((c, i) => ({ key: `e${i + 1}`, item: c }));
  const listing = keyed.map(({ key, item }) => ({
    key,
    title: item.title,
    start: item.start,
    end: item.end,
    allDay: item.allDay,
    location: item.location || undefined,
    calendars: item.sources
  }));

  const cacheKey = crypto.createHash('sha256').update(JSON.stringify(listing)).digest('hex');
  if (aiCache.has(cacheKey)) return { status: 'cached', groups: aiCache.get(cacheKey) };

  const prompt = `These events come from several of one person's calendars (work, personal, shared family calendars, booking platforms). The same real-world event often shows up more than once with different wording, a calendar prefix, or a slightly different time.

Group together the events that are the SAME real-world event, such as "Dr. Smith" and "Doctor appointment" at nearly the same time, or "Team sync" and "Weekly team meeting". Only group events you are confident are the same occurrence. Two different events of the same kind (two separate meetings, a lunch and a dinner) stay apart. Leave out every event that has no duplicate; groups must have 2 or more keys.

Events:
${JSON.stringify(listing)}`;

  try {
    const response = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: GROUPS_SCHEMA } },
      messages: [{ role: 'user', content: prompt }]
    });

    if (response.stop_reason === 'refusal') return { status: 'error', groups: [] };
    const text = response.content.find(b => b.type === 'text')?.text;
    if (!text) return { status: 'error', groups: [] };

    const byKey = new Map(keyed.map(({ key, item }) => [key, item.id]));
    const groups = (JSON.parse(text).groups || [])
      .map(g => ({ ids: [...new Set(g.keys.map(k => byKey.get(k)).filter(Boolean))], reason: g.reason }))
      .filter(g => g.ids.length >= 2);

    if (aiCache.size >= MAX_AI_CACHE) aiCache.delete(aiCache.keys().next().value);
    aiCache.set(cacheKey, groups);
    return { status: 'ok', groups };
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) {
      console.error('AI agenda grouping rate limited');
    } else if (error instanceof Anthropic.APIError) {
      console.error(`AI agenda grouping failed (${error.status}):`, error.message);
    } else {
      console.error('AI agenda grouping failed:', error.message);
    }
    return { status: 'error', groups: [] };
  }
}


export async function buildAgenda(days = 14) {
  const { events, calendars } = await getCombinedEvents();
  const now = Date.now();
  const from = now - 24 * 60 * 60 * 1000; // the page hides anything already over
  const to = now + days * 24 * 60 * 60 * 1000;

  let items = events.map(toItem).filter(item => {
    const s = new Date(item.start).getTime();
    const e = new Date(item.end).getTime();
    return !isNaN(s) && s < to && (isNaN(e) ? s : e) > from;
  });

  const exactDuplicatesRemoved = items.reduce((n, item) => n + item.sources.length - 1, 0);
  const candidates = findCandidates(items);
  const ai = candidates.length >= 2 ? await askClaudeForGroups(candidates) : { status: getClient() ? 'ok' : 'off', groups: [] };
  items = applyGroups(items, ai.groups);
  items.sort((a, b) => startMs(a) - startMs(b));

  return {
    generatedAt: new Date(now).toISOString(),
    days,
    ai: ai.status,
    calendars: calendars.map(c => c.calendar_name).filter(Boolean),
    stats: {
      shown: items.length,
      mergedByAi: items.filter(i => i.merged).length,
      sharedAcrossCalendars: exactDuplicatesRemoved
    },
    events: items
  };
}

// --- Route ---

const responseCache = new Map(); // days -> { at, promise }

function isAuthorized(req) {
  if (!process.env.BASIC_AUTH_PASSWORD || req.session?.authenticated) return true;
  const expected = getIcsToken();
  const header = req.get('authorization') || '';
  const given = req.query.token || (header.startsWith('Bearer ') ? header.slice(7) : '');
  if (!expected || !given || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export const agendaRouter = express.Router();

agendaRouter.get('/', async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Not authenticated' });

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), 60);
  const fresh = req.query.refresh === '1';
  let entry = responseCache.get(days);
  if (fresh || !entry || Date.now() - entry.at > RESPONSE_TTL_MS) {
    entry = { at: Date.now(), promise: buildAgenda(days) };
    responseCache.set(days, entry);
    entry.promise.catch(() => responseCache.delete(days));
  }

  try {
    res.set('Cache-Control', 'no-store');
    res.json(await entry.promise);
  } catch (error) {
    console.error('Agenda build failed:', error);
    res.status(500).json({ error: error.message });
  }
});
