// Agenda widget for Scriptable (iOS). Shows the de-duplicated agenda from
// Calendar Sync's /api/agenda as a home-screen or lock-screen widget.
//
// Setup: put this script in Scriptable, run it once in the app and paste the
// ICS token when asked (stored in the iOS Keychain, never in this file).
// Then add a Scriptable widget and pick "Agenda" as its script.
// Run it in the app again any time to preview or to change the token.

const BASE_URL = 'https://calendar-sync-ljbw-w.fly.dev';
const TOKEN_KEY = 'calendar-sync-agenda-token';
const CACHE_FILE = 'agenda-widget-cache.json';
const REFRESH_MINUTES = 15;

// ---------- data ----------

async function getToken({ ask }) {
  if (Keychain.contains(TOKEN_KEY) && !ask) return Keychain.get(TOKEN_KEY);
  if (config.runsInWidget) return null;
  const alert = new Alert();
  alert.title = 'Calendar Sync token';
  alert.message = 'Paste the token from your combined ICS feed URL (the part after token=).';
  alert.addSecureTextField('token', Keychain.contains(TOKEN_KEY) ? Keychain.get(TOKEN_KEY) : '');
  alert.addAction('Save');
  alert.addCancelAction('Cancel');
  if ((await alert.presentAlert()) === -1) return null;
  const token = alert.textFieldValue(0).trim().replace(/^.*token=/, '');
  if (token) Keychain.set(TOKEN_KEY, token);
  return token || null;
}

function cachePath() {
  const fm = FileManager.local();
  return fm.joinPath(fm.documentsDirectory(), CACHE_FILE);
}

async function loadAgenda(token) {
  try {
    const req = new Request(`${BASE_URL}/api/agenda?days=7`);
    req.headers = { Authorization: `Bearer ${token}` };
    req.timeoutInterval = 20;
    const data = await req.loadJSON();
    if (req.response.statusCode === 401) return { error: 'Token not accepted. Run the script in Scriptable to update it.' };
    if (req.response.statusCode !== 200) throw new Error(data.error || `HTTP ${req.response.statusCode}`);
    FileManager.local().writeString(cachePath(), JSON.stringify(data));
    return { data };
  } catch (err) {
    const fm = FileManager.local();
    if (fm.fileExists(cachePath())) return { data: JSON.parse(fm.readString(cachePath())), stale: true };
    return { error: `Couldn't reach Calendar Sync (${err.message || err}).` };
  }
}

// ---------- dates ----------

const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
// All-day dates ("2026-11-14") are calendar dates, not UTC instants.
function parse(value, allDay) {
  if (allDay) { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d); }
  return new Date(value);
}
function fmtTime(d) {
  const f = new DateFormatter();
  f.useNoDateStyle(); f.useShortTimeStyle();
  return f.string(d);
}
function fmt(d, pattern) { const f = new DateFormatter(); f.dateFormat = pattern; return f.string(d); }
function dayTitle(d, now) {
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : fmt(d, 'EEEE');
}

// Group into days: timed events not yet over, plus all-day events covering that day.
function buildDays(events, now, maxDays) {
  const today = startOfDay(now);
  const days = [];
  for (let i = 0; i < maxDays; i++) {
    const day = addDays(today, i), next = addDays(today, i + 1);
    const allDay = [], timed = [];
    for (const ev of events) {
      const s = parse(ev.start, ev.allDay), e = parse(ev.end, ev.allDay);
      if (ev.allDay) { if (s < next && e > day) allDay.push(ev); }
      else if (s >= day && s < next && e > now) timed.push({ ...ev, s, e });
    }
    timed.sort((a, b) => a.s - b.s);
    if (allDay.length || timed.length) days.push({ day, allDay, timed });
  }
  return days;
}

// ---------- look ----------

const C = {
  bg: Color.dynamic(new Color('#f6f5f2'), new Color('#121214')),
  text: Color.dynamic(new Color('#1b1b1f'), new Color('#ededf0')),
  muted: Color.dynamic(new Color('#6e6e76'), new Color('#9a9aa3')),
  faint: Color.dynamic(new Color('#a3a3ab'), new Color('#65656d')),
  accent: Color.dynamic(new Color('#5b5bd6'), new Color('#9b9bf5')),
};

// Same calendar name -> same hue as the web page.
function hue(name) { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function hslHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, '0');
  return `#${f(0)}${f(8)}${f(4)}`;
}
function calColor(ev) {
  const h = hue(ev.sources?.[0] || '');
  return Color.dynamic(new Color(hslHex(h, 55, 45)), new Color(hslHex(h, 60, 68)));
}

function text(stack, value, { size = 13, weight = 'regular', color = C.text, lines = 1 } = {}) {
  const t = stack.addText(value);
  t.font = weight === 'bold' ? Font.boldSystemFont(size)
    : weight === 'semibold' ? Font.semiboldSystemFont(size)
    : weight === 'medium' ? Font.mediumSystemFont(size) : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = lines;
  return t;
}

function eventRow(parent, ev, now, { size = 13 } = {}) {
  const row = parent.addStack();
  row.centerAlignContent();
  row.spacing = 6;
  const bar = row.addStack();
  bar.size = new Size(3, size + 6);
  bar.cornerRadius = 1.5;
  bar.backgroundColor = calColor(ev);
  const live = ev.s <= now && ev.e > now;
  const time = text(row, live ? 'Now' : fmtTime(ev.s), { size: size - 1, weight: 'medium', color: live ? C.accent : C.muted });
  time.font = Font.mediumMonospacedSystemFont(size - 1.5);
  text(row, ev.title, { size, weight: 'semibold' });
  row.addSpacer();
}

function allDayLine(parent, list, { size = 11 } = {}) {
  if (!list.length) return;
  const extra = list.length > 1 ? `  +${list.length - 1}` : '';
  text(parent, `All day · ${list[0].title}${extra}`, { size, color: C.faint });
}

// ---------- layouts ----------

function header(w, now, stale) {
  const top = w.addStack();
  top.centerAlignContent();
  text(top, fmt(now, 'EEE d').toUpperCase(), { size: 11, weight: 'bold', color: C.accent });
  top.addSpacer();
  if (stale) text(top, 'offline', { size: 10, color: C.faint });
}

function small(w, days, now, stale) {
  header(w, now, stale);
  w.addSpacer(6);
  const next = days.flatMap(d => d.timed)[0];
  if (!next) {
    text(w, 'Nothing else this week', { size: 14, weight: 'semibold', lines: 2 });
  } else {
    const label = startOfDay(next.s) > startOfDay(now) ? `${dayTitle(next.s, now)} ${fmtTime(next.s)}` : (next.s <= now ? 'Now' : fmtTime(next.s));
    text(w, label, { size: 12, weight: 'semibold', color: calColor(next) });
    text(w, next.title, { size: 15, weight: 'bold', lines: 3 });
    if (next.location) text(w, next.location, { size: 11, color: C.muted });
  }
  w.addSpacer();
  const todayCount = days[0] && startOfDay(days[0].day).getTime() === startOfDay(now).getTime() ? days[0].timed.length : 0;
  if (todayCount > 1) text(w, `+${todayCount - 1} more today`, { size: 11, color: C.muted });
  else if (days[0]?.allDay.length) allDayLine(w, days[0].allDay);
}

// Fills the widget top-down within a height budget (points, below the header),
// so nothing gets clipped: a day title is only shown if one item fits under it.
const H = { dayTitle: 18, event: 22, allDay: 15, dayGap: 5 };
function list(w, days, now, stale, budget) {
  header(w, now, stale);
  w.addSpacer(6);
  let used = 0, first = true;
  for (const { day, allDay, timed } of days) {
    const gap = first ? 0 : H.dayGap;
    const firstItem = timed.length ? H.event : H.allDay;
    if (used + gap + H.dayTitle + firstItem > budget) break;
    if (!first) w.addSpacer(H.dayGap);
    used += gap + H.dayTitle;
    first = false;
    text(w, dayTitle(day, now), { size: 12, weight: 'bold', color: C.muted });
    w.addSpacer(3);
    for (const ev of timed) {
      if (used + H.event > budget) break;
      eventRow(w, ev, now);
      w.addSpacer(3);
      used += H.event;
    }
    if (allDay.length && used + H.allDay <= budget) { allDayLine(w, allDay); used += H.allDay; }
  }
  if (!days.length) text(w, 'Nothing on the calendar this week', { size: 13, color: C.muted });
  w.addSpacer();
}

function lockScreen(w, days, now) {
  const next = days.flatMap(d => d.timed)[0];
  if (!next) { text(w, 'No more events', { size: 13 }); return; }
  const when = next.s <= now ? `Now · until ${fmtTime(next.e)}`
    : startOfDay(next.s) > startOfDay(now) ? `${dayTitle(next.s, now)} ${fmtTime(next.s)}` : fmtTime(next.s);
  text(w, when, { size: 12, weight: 'semibold' });
  text(w, next.title, { size: 14, weight: 'bold', lines: 2 });
}

// ---------- main ----------

const now = new Date();
const family = config.widgetFamily || 'large';
const w = new ListWidget();
w.url = `${BASE_URL}/agenda`;
w.refreshAfterDate = new Date(now.getTime() + REFRESH_MINUTES * 60000);

const isLock = family.startsWith('accessory');
if (!isLock) { w.backgroundColor = C.bg; w.setPadding(14, 14, 12, 14); }

const token = await getToken({ ask: false });
const result = token ? await loadAgenda(token) : { error: 'Open Scriptable and run "Agenda" once to add your token.' };

if (result.error) {
  text(w, result.error, { size: isLock ? 12 : 13, color: isLock ? Color.white() : C.muted, lines: 4 });
} else {
  const days = buildDays(result.data.events, now, 7);
  if (family === 'accessoryRectangular' || family === 'accessoryInline' || family === 'accessoryCircular') lockScreen(w, days, now);
  else if (family === 'small') small(w, days, now, result.stale);
  else if (family === 'medium') list(w, days, now, result.stale, 100);
  else list(w, days, now, result.stale, family === 'extraLarge' ? 300 : 290);
}

if (config.runsInWidget) {
  Script.setWidget(w);
} else {
  // In the app: preview, with a way to change the token.
  const menu = new Alert();
  menu.title = 'Agenda widget';
  menu.addAction('Preview small');
  menu.addAction('Preview medium');
  menu.addAction('Preview large');
  menu.addAction('Change token');
  menu.addCancelAction('Done');
  const pick = await menu.presentSheet();
  if (pick === 3) { await getToken({ ask: true }); }
  else if (pick >= 0) {
    const fam = ['small', 'medium', 'large'][pick];
    const preview = new ListWidget();
    preview.backgroundColor = C.bg;
    preview.setPadding(14, 14, 12, 14);
    if (result.data) {
      const days = buildDays(result.data.events, now, 7);
      if (fam === 'small') small(preview, days, now, result.stale);
      else list(preview, days, now, result.stale, fam === 'medium' ? 100 : 290);
    } else {
      text(preview, result.error || 'No data', { size: 13, color: C.muted, lines: 4 });
    }
    if (fam === 'small') await preview.presentSmall();
    else if (fam === 'medium') await preview.presentMedium();
    else await preview.presentLarge();
  }
}
Script.complete();
