// Pure helpers for the agenda view: shaping events and collapsing duplicate
// groups. No I/O here, so they can be tested without Google or Anthropic.

export const NEAR_MS = 3 * 60 * 60 * 1000; // events starting >3h apart are never merged

export function startMs(item) { return new Date(item.start).getTime(); }

export function toItem(event) {
  const allDay = !event.start?.dateTime;
  const start = event.start?.dateTime || event.start?.date;
  const end = event.end?.dateTime || event.end?.date || start;
  return {
    id: String(event.id),
    title: event._cleanTitle || event.summary || '(no title)',
    start,
    end,
    allDay,
    location: event.location || null,
    sources: event._sources?.length ? [...event._sources] : [event._calendarName].filter(Boolean),
    // Synced copies of wedding-calendar events carry a " Wedding" suffix.
    taggedWedding: /\bwedding\s*$/i.test((event.summary || '').trim()),
    merged: null
  };
}

// Which calendars hold weddings: AGENDA_WEDDING_CALENDARS (comma-separated
// name fragments) if set, otherwise any calendar named like HoneyBook/Wedding
// or one that tags its synced copies with "Wedding".
export function weddingCalendarNames(calendars, setting = '') {
  const wanted = setting.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return new Set(calendars.filter(c => {
    const name = (c.calendar_name || '').toLowerCase();
    if (wanted.length) return wanted.some(w => name.includes(w));
    return /honeybook|wedding/.test(name) || /wedding/i.test(`${c.prefix || ''} ${c.suffix || ''}`);
  }).map(c => c.calendar_name));
}

// Booking calendars also carry appointments related to a wedding.
const NON_WEDDING_TITLE = /\b(?:check[\s‐‑–—-]*in|touch[\s‐‑–—-]+base|meeting|consult(?:ation)?|(?:planning|discovery|intro|follow[\s-]*up) call|rehearsal|walk[\s-]*through|site visit)\b/i;

export function markWeddings(items, weddingCalendars) {
  return items.map(item => ({
    ...item,
    wedding: (item.taggedWedding || item.sources.some(s => weddingCalendars.has(s)))
      && !NON_WEDDING_TITLE.test(item.title)
      && !item.merged?.versions.some(version => NON_WEDDING_TITLE.test(version.title))
  }));
}

// Pairs that could plausibly be the same real-world event: close in time.
export function findCandidates(items) {
  const ids = new Set();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const close = a.allDay && b.allDay
        ? a.start === b.start
        : !a.allDay && !b.allDay && Math.abs(startMs(a) - startMs(b)) <= NEAR_MS;
      if (close) { ids.add(a.id); ids.add(b.id); }
    }
  }
  return items.filter(item => ids.has(item.id));
}

// Collapse each validated group into one item that remembers what it absorbed.
export function applyGroups(items, groups) {
  const byId = new Map(items.map(item => [item.id, item]));
  const absorbed = new Set();
  const replacements = new Map();

  for (const group of groups) {
    const members = group.ids.map(id => byId.get(id)).filter(m => m && !absorbed.has(m.id));
    if (members.length < 2) continue;
    // Never trust a group whose members are far apart in time, whatever the model said.
    const starts = members.map(startMs);
    if (Math.max(...starts) - Math.min(...starts) > NEAR_MS) continue;

    // Keep the most informative version: timed over all-day, then has a location, then longer title.
    const rep = [...members].sort((a, b) =>
      (a.allDay - b.allDay) || (!!b.location - !!a.location) || (b.title.length - a.title.length))[0];

    replacements.set(rep.id, {
      ...rep,
      sources: [...new Set(members.flatMap(m => m.sources))],
      taggedWedding: members.some(m => m.taggedWedding),
      merged: {
        reason: group.reason,
        versions: members.map(m => ({ title: m.title, start: m.start, sources: m.sources }))
      }
    });
    members.forEach(m => absorbed.add(m.id));
  }

  return items
    .filter(item => !absorbed.has(item.id) || replacements.has(item.id))
    .map(item => replacements.get(item.id) || item);
}
