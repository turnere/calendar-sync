// Agenda widget for Scriptable (iOS). Shows the de-duplicated agenda from
// Calendar Sync's /api/agenda as a home-screen or lock-screen widget, styled
// after Apple's Calendar "Up Next" widget, in black and white.
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
function fmt(d, pattern) { const f = new DateFormatter(); f.dateFormat = pattern; return f.string(d); }
// Apple-style ranges: "7–8PM", "11AM–12PM", "9:15–10:15PM".
function clock(d, withPeriod) {
  const h = d.getHours() % 12 || 12, m = d.getMinutes();
  return `${h}${m ? ':' + String(m).padStart(2, '0') : ''}${withPeriod ? (d.getHours() < 12 ? 'AM' : 'PM') : ''}`;
}
function timeRange(s, e) {
  const samePeriod = (s.getHours() < 12) === (e.getHours() < 12);
  return `${clock(s, !samePeriod)}–${clock(e, true)}`;
}
function dayLabel(d, now) {
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  if (diff === 0) return 'LATER TODAY';
  if (diff === 1) return 'TOMORROW';
  return fmt(d, 'EEEE, MMM d').toUpperCase();
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
    days.push({ day, allDay, timed });
  }
  return days;
}

// ---------- look: black & white, frosted ----------

const dyn = (light, dark) => Color.dynamic(light, dark);
const C = {
  text: dyn(new Color('#000000'), new Color('#ffffff')),
  secondary: dyn(new Color('#000000', 0.55), new Color('#ffffff', 0.6)),
  tertiary: dyn(new Color('#000000', 0.35), new Color('#ffffff', 0.38)),
  block: dyn(new Color('#000000', 0.06), new Color('#ffffff', 0.12)),
  blockNow: dyn(new Color('#000000', 0.13), new Color('#ffffff', 0.22)),
  bar: dyn(new Color('#000000'), new Color('#ffffff')),
};

// Frosted panel: soft diagonal sheen with a brighter top edge, like light
// catching glass. iOS doesn't let Scriptable blur the wallpaper itself.
function glass(w) {
  const g = new LinearGradient();
  g.colors = [
    dyn(new Color('#ffffff'), new Color('#3a3a3d')),
    dyn(new Color('#f3f3f5'), new Color('#232325')),
    dyn(new Color('#e9e9ec'), new Color('#161618')),
  ];
  g.locations = [0, 0.45, 1];
  g.startPoint = new Point(0, 0);
  g.endPoint = new Point(0.7, 1);
  w.backgroundGradient = g;
}

function font(weight, size) {
  return {
    light: Font.lightSystemFont, regular: Font.regularSystemFont, medium: Font.mediumSystemFont,
    semibold: Font.semiboldSystemFont, bold: Font.boldSystemFont, heavy: Font.heavySystemFont,
  }[weight](size);
}
function text(stack, value, { size = 13, weight = 'regular', color = C.text, lines = 1 } = {}) {
  const t = stack.addText(value);
  t.font = font(weight, size);
  t.textColor = color;
  t.lineLimit = lines;
  return t;
}

// Widget sizes in points for the current phone, so blocks can fill their column.
function widgetWidth(family) {
  const sw = Device.screenSize().width;
  const small = sw >= 428 ? 170 : sw >= 414 ? 169 : sw >= 390 ? 158 : sw >= 375 ? 155 : 141;
  const gap = sw >= 414 ? 24 : sw >= 390 ? 22 : 20;
  return family === 'small' ? small : small * 2 + gap;
}
const PAD = 15;

// One event, Apple style: tinted rounded block, bar on the left, title + time.
function eventBlock(parent, ev, now, width, { location = true, titleLines = 1 } = {}) {
  const live = ev.s <= now && ev.e > now;
  const lines = 1 + titleLines + (location && ev.location ? 1 : 0);
  const height = 6 + 15 + (lines - 1) * 13.5;

  const block = parent.addStack();
  block.size = new Size(width, height);
  block.cornerRadius = 6;
  block.backgroundColor = live ? C.blockNow : C.block;
  block.setPadding(3, 4, 3, 6);
  block.centerAlignContent();

  const bar = block.addStack();
  bar.size = new Size(3, height - 6);
  bar.cornerRadius = 1.5;
  bar.backgroundColor = C.bar;
  block.addSpacer(6);

  const body = block.addStack();
  body.layoutVertically();
  text(body, ev.title, { size: 13, weight: 'semibold', lines: titleLines });
  if (location && ev.location) text(body, ev.location, { size: 11.5, color: C.secondary });
  text(body, live ? `Now · until ${clock(ev.e, true)}` : timeRange(ev.s, ev.e), { size: 11.5, weight: live ? 'semibold' : 'regular', color: C.secondary });
  block.addSpacer();
  return height;
}

function allDayText(parent, list, { size = 11.5 } = {}) {
  if (!list.length) return 0;
  const extra = list.length > 1 ? ` +${list.length - 1}` : '';
  text(parent, `${list[0].title}${extra}`, { size, color: C.tertiary });
  return 15;
}

function dateHeader(parent, now, stale, { big = 34 } = {}) {
  const row = parent.addStack();
  row.centerAlignContent();
  text(row, fmt(now, 'EEEE').toUpperCase(), { size: 11.5, weight: 'bold' });
  if (stale) { row.addSpacer(6); text(row, 'OFFLINE', { size: 9.5, weight: 'semibold', color: C.tertiary }); }
  row.addSpacer();
  text(parent, String(now.getDate()), { size: big, weight: 'light' });
}

const EMPTY_TODAY = 'No more events today';

// Fills a column top-down within a height budget so nothing gets clipped.
// Each day: label, then event blocks, then a quiet all-day line.
function upcoming(col, days, now, width, budget, { skipFirstTimed = 0 } = {}) {
  const LABEL = 17, GAP = 4, DAY_GAP = 6;
  let used = 0, first = true, shown = 0;
  days.forEach(({ day, timed, label }, i) => {
    const events = i === 0 ? timed.slice(skipFirstTimed) : timed;
    if (!events.length) return;
    const firstH = 6 + 15 + 13.5;
    if (used + (first ? 0 : DAY_GAP) + LABEL + firstH > budget) { used = budget + 1; return; }
    if (!first) { col.addSpacer(DAY_GAP); used += DAY_GAP; }
    first = false;
    text(col, label || dayLabel(day, now), { size: 10.5, weight: 'semibold', color: C.secondary });
    col.addSpacer(3);
    used += LABEL;
    for (const ev of events) {
      const h = 6 + 15 + 13.5 + (ev.location ? 13.5 : 0);
      if (used + h > budget) {
        if (used + firstH <= budget) { used += eventBlock(col, ev, now, width, { location: false }) + GAP; col.addSpacer(GAP); shown++; }
        used = budget + 1;
        return;
      }
      used += eventBlock(col, ev, now, width) + GAP;
      col.addSpacer(GAP);
      shown++;
    }
  });
  return shown;
}

// ---------- layouts ----------

function small(w, days, now, stale) {
  const inner = widgetWidth('small') - PAD * 2;
  dateHeader(w, now, stale, { big: 30 });
  w.addSpacer(4);
  const today = days[0];
  if (today.timed.length) {
    eventBlock(w, today.timed[0], now, inner, { location: false, titleLines: 2 });
    if (today.timed.length > 1) { w.addSpacer(4); text(w, `+${today.timed.length - 1} more today`, { size: 11, color: C.tertiary }); }
  } else {
    allDayText(w, today.allDay);
    const next = days.slice(1).find(d => d.timed.length);
    if (next) {
      w.addSpacer(3);
      text(w, dayLabel(next.day, now), { size: 10, weight: 'semibold', color: C.secondary });
      w.addSpacer(2);
      eventBlock(w, next.timed[0], now, inner, { location: false });
    } else {
      text(w, EMPTY_TODAY, { size: 12, color: C.secondary, lines: 2 });
    }
  }
  w.addSpacer();
}

function medium(w, days, now, stale) {
  const width = widgetWidth('medium');
  const colW = (width - PAD * 2 - 14) / 2;
  const row = w.addStack();
  row.topAlignContent();

  // Left: date and today's next events.
  const left = row.addStack();
  left.layoutVertically();
  left.size = new Size(colW, 0);
  dateHeader(left, now, stale, { big: 36 });
  left.addSpacer(2);
  const today = days[0];
  let onLeft = 0;
  if (today.allDay.length) { allDayText(left, today.allDay); left.addSpacer(3); }
  const leftBudget = today.allDay.length ? 52 : 68;
  let used = 0;
  for (const ev of today.timed) {
    const h = 6 + 15 + 13.5;
    if (used + h > leftBudget) break;
    used += eventBlock(left, ev, now, colW, { location: false }) + 4;
    left.addSpacer(4);
    onLeft++;
  }
  if (!today.timed.length && !today.allDay.length) text(left, EMPTY_TODAY, { size: 12, color: C.secondary, lines: 2 });
  left.addSpacer();

  row.addSpacer(14);

  // Right: what comes after.
  const right = row.addStack();
  right.layoutVertically();
  right.size = new Size(colW, 0);
  const shown = upcoming(right, days, now, colW, 128, { skipFirstTimed: onLeft });
  if (!shown) text(right, 'Nothing else this week', { size: 12, color: C.secondary, lines: 2 });
  right.addSpacer();
}

function large(w, days, now, stale) {
  const inner = widgetWidth('medium') - PAD * 2;
  dateHeader(w, now, stale, { big: 38 });
  const allDayH = allDayText(w, days[0].allDay);
  w.addSpacer(8);
  const list = w.addStack();
  list.layoutVertically();
  // The large widget lists today too, so it reads "TODAY" rather than "LATER TODAY".
  const shown = upcoming(list, [{ ...days[0], label: 'TODAY' }, ...days.slice(1)], now, inner, 262 - allDayH);
  if (!shown) text(list, 'Nothing on the calendar this week', { size: 13, color: C.secondary });
  w.addSpacer();
}

function lockScreen(w, days, now) {
  const next = days.flatMap(d => d.timed)[0];
  if (!next) { text(w, 'No more events', { size: 13 }); return; }
  const diff = Math.round((startOfDay(next.s) - startOfDay(now)) / 86400000);
  const when = next.s <= now ? `Now · until ${clock(next.e, true)}`
    : diff === 0 ? timeRange(next.s, next.e)
    : `${diff === 1 ? 'Tomorrow' : fmt(next.s, 'EEE')} ${clock(next.s, true)}`;
  text(w, when, { size: 12, weight: 'semibold' });
  text(w, next.title, { size: 14, weight: 'bold', lines: 2 });
}

function render(w, family, result, now) {
  const isLock = family.startsWith('accessory');
  if (!isLock) { glass(w); w.setPadding(PAD, PAD, PAD - 2, PAD); }
  if (result.error) {
    text(w, result.error, { size: isLock ? 12 : 13, color: isLock ? Color.white() : C.secondary, lines: 4 });
    return;
  }
  const days = buildDays(result.data.events, now, 7);
  if (isLock) lockScreen(w, days, now);
  else if (family === 'small') small(w, days, now, result.stale);
  else if (family === 'medium') medium(w, days, now, result.stale);
  else large(w, days, now, result.stale);
}

// ---------- main ----------

const now = new Date();
const token = await getToken({ ask: false });
const result = token ? await loadAgenda(token) : { error: 'Open Scriptable and run "Agenda" once to add your token.' };

if (config.runsInWidget) {
  const family = config.widgetFamily || 'medium';
  const w = new ListWidget();
  w.url = `${BASE_URL}/agenda`;
  w.refreshAfterDate = new Date(now.getTime() + REFRESH_MINUTES * 60000);
  render(w, family, result, now);
  Script.setWidget(w);
} else {
  // In the app: preview each size, or change the token.
  const menu = new Alert();
  menu.title = 'Agenda widget';
  menu.addAction('Preview small');
  menu.addAction('Preview medium');
  menu.addAction('Preview large');
  menu.addAction('Change token');
  menu.addCancelAction('Done');
  const pick = await menu.presentSheet();
  if (pick === 3) {
    await getToken({ ask: true });
  } else if (pick >= 0) {
    const fam = ['small', 'medium', 'large'][pick];
    const preview = new ListWidget();
    render(preview, fam, result, now);
    if (fam === 'small') await preview.presentSmall();
    else if (fam === 'medium') await preview.presentMedium();
    else await preview.presentLarge();
  }
}
Script.complete();
