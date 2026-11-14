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
    const allDay = [], timed = [], weddings = [];
    for (const ev of events) {
      const s = parse(ev.start, ev.allDay), e = parse(ev.end, ev.allDay);
      const covers = ev.allDay ? s < next && e > day : s >= day && s < next && e > now;
      if (!covers) continue;
      // Weddings get their own bold block, whether all-day or timed.
      if (ev.wedding) weddings.push({ ...ev, s, e });
      else if (ev.allDay) allDay.push(ev);
      else timed.push({ ...ev, s, e });
    }
    timed.sort((a, b) => a.s - b.s);
    days.push({ day, allDay, timed, weddings });
  }
  return days;
}

// ---------- look: black & white, frosted ----------

const dyn = (light, dark) => Color.dynamic(light, dark);
// tone: 'auto' follows the phone's appearance; 'light'/'dark' are fixed, used
// when the widget sits on a frosted wallpaper crop of a known tone.
function palette(tone) {
  const pick = (light, dark) => tone === 'light' ? light : tone === 'dark' ? dark : dyn(light, dark);
  return {
    text: pick(new Color('#000000'), new Color('#ffffff')),
    secondary: pick(new Color('#000000', 0.6), new Color('#ffffff', 0.68)),
    tertiary: pick(new Color('#000000', 0.42), new Color('#ffffff', 0.48)),
    // On frosted glass, blocks are brighter panes; on the plain panel, faint grey tints.
    block: tone === 'auto' ? dyn(new Color('#000000', 0.06), new Color('#ffffff', 0.12))
      : tone === 'light' ? new Color('#ffffff', 0.45) : new Color('#ffffff', 0.14),
    blockNow: tone === 'auto' ? dyn(new Color('#000000', 0.13), new Color('#ffffff', 0.22))
      : tone === 'light' ? new Color('#ffffff', 0.7) : new Color('#ffffff', 0.26),
    bar: pick(new Color('#000000'), new Color('#ffffff')),
    // All-day box: fainter than event blocks, with a hairline edge.
    allDay: tone === 'auto' ? dyn(new Color('#000000', 0.025), new Color('#ffffff', 0.05))
      : tone === 'light' ? new Color('#ffffff', 0.22) : new Color('#ffffff', 0.06),
    allDayEdge: pick(new Color('#000000', 0.09), new Color('#ffffff', 0.12)),
    // Weddings: solid inverted block (black on light, white on dark).
    wed: pick(new Color('#000000'), new Color('#ffffff')),
    wedText: pick(new Color('#ffffff'), new Color('#000000')),
    wedMuted: pick(new Color('#ffffff', 0.7), new Color('#000000', 0.62)),
  };
}
let C = palette('auto');

// ---------- frosted wallpaper ("glass") ----------
// A widget can't see the wallpaper, so we fake it: crop the widget's spot out
// of a screenshot of an empty home-screen page, blur it heavily and frost it.

const GLASS_SETTINGS = 'agenda-glass.json';
// Widget slots measured on a 1179×2556 screenshot (iPhone 15/16 Pro), scaled
// to the actual screenshot. The heavy blur hides small differences between models.
const REF = { W: 1179, H: 2556, small: 474, medium: 1017, largeH: 1062, left: 82, right: 622, top: 270, middle: 858, bottom: 1446 };
const SLOTS = {
  small: ['top left', 'top right', 'middle left', 'middle right', 'bottom left', 'bottom right'],
  medium: ['top', 'middle', 'bottom'],
  large: ['top', 'bottom'],
};

function glassFiles() {
  const fm = FileManager.local();
  const dir = fm.documentsDirectory();
  const settingsPath = fm.joinPath(dir, GLASS_SETTINGS);
  const settings = fm.fileExists(settingsPath) ? JSON.parse(fm.readString(settingsPath)) : { defaults: {}, tones: {} };
  return {
    fm, settings,
    image: key => fm.joinPath(dir, `agenda-glass-${key.replace(/\s+/g, '-')}.png`),
    save: () => fm.writeString(settingsPath, JSON.stringify(settings)),
  };
}

function slotRect(img, family, slot) {
  const s = img.size.width / REF.W, v = img.size.height / REF.H;
  const col = /right/.test(slot) ? REF.right : REF.left;
  const row = /bottom/.test(slot) ? (family === 'large' ? REF.middle : REF.bottom) : /middle/.test(slot) ? REF.middle : REF.top;
  const w = family === 'small' ? REF.small : REF.medium;
  const h = family === 'large' ? REF.largeH : REF.small;
  return new Rect(col * s, row * v, w * s, h * s);
}

function frost(img, rect, tone) {
  const draw = (size, fn) => { const c = new DrawContext(); c.size = size; c.opaque = true; c.respectScreenScale = false; fn(c); return c.getImage(); };
  const full = new Size(Math.round(rect.width), Math.round(rect.height));
  const crop = draw(full, c => c.drawImageAtPoint(img, new Point(-rect.x, -rect.y)));
  // Shrink then enlarge twice: smooth scaling turns into a soft blur.
  let blurred = crop;
  for (const f of [10, 4]) {
    const tiny = draw(new Size(Math.max(1, Math.round(full.width / f)), Math.max(1, Math.round(full.height / f))), c => c.drawImageInRect(blurred, new Rect(0, 0, full.width / f, full.height / f)));
    blurred = draw(full, c => c.drawImageInRect(tiny, new Rect(0, 0, full.width, full.height)));
  }
  return draw(full, c => {
    c.drawImageInRect(blurred, new Rect(0, 0, full.width, full.height));
    c.setFillColor(tone === 'light' ? new Color('#ffffff', 0.42) : new Color('#000000', 0.38));
    c.fillRect(new Rect(0, 0, full.width, full.height));
  });
}

async function chooseFrom(title, message, options) {
  const a = new Alert();
  a.title = title;
  if (message) a.message = message;
  options.forEach(o => a.addAction(o));
  a.addCancelAction('Cancel');
  const i = await a.presentSheet();
  return i < 0 ? null : options[i];
}

async function setUpGlass() {
  const intro = new Alert();
  intro.title = 'Frosted wallpaper background';
  intro.message = 'First take a screenshot of an empty home-screen page: long-press the home screen, swipe left past your last page so it is empty, then take the screenshot. Then pick it here.';
  intro.addAction('Pick screenshot');
  intro.addCancelAction('Cancel');
  if ((await intro.presentAlert()) === -1) return;
  const img = await Photos.fromLibrary();
  const family = await chooseFrom('Widget size', null, ['small', 'medium', 'large']);
  if (!family) return;
  const slot = await chooseFrom('Where is the widget?', `Position of the ${family} widget on your home screen`, SLOTS[family]);
  if (!slot) return;
  const toneLabel = await chooseFrom('Glass tone', 'Light: white frosting, black text. Dark: smoky frosting, white text.', ['Light', 'Dark']);
  if (!toneLabel) return;
  const tone = toneLabel.toLowerCase();

  const g = glassFiles();
  const key = `${family} ${slot}`;
  g.fm.writeImage(g.image(key), frost(img, slotRect(img, family, slot), tone));
  g.settings.tones[key] = tone;
  g.settings.defaults[family] = key;
  g.save();

  const done = new Alert();
  done.title = 'Glass background saved';
  done.message = `Your ${family} widgets now use it. If you have more than one ${family} widget, long-press the widget → Edit Widget → Parameter and type:\n\n${key}`;
  done.addAction('OK');
  await done.presentAlert();
}

async function removeGlass() {
  const g = glassFiles();
  const keys = Object.keys(g.settings.tones);
  if (!keys.length) { const a = new Alert(); a.title = 'No glass backgrounds set'; a.addAction('OK'); await a.presentAlert(); return; }
  const key = await chooseFrom('Remove glass background', null, [...keys, 'All of them']);
  if (!key) return;
  for (const k of key === 'All of them' ? keys : [key]) {
    if (g.fm.fileExists(g.image(k))) g.fm.remove(g.image(k));
    delete g.settings.tones[k];
    for (const f of Object.keys(g.settings.defaults)) if (g.settings.defaults[f] === k) delete g.settings.defaults[f];
  }
  g.save();
}

// Returns the tone used, or null if this widget has no glass background.
function applyGlass(w, family, parameter) {
  const g = glassFiles();
  const key = (parameter || '').trim().toLowerCase() || g.settings.defaults[family];
  if (!key || !g.settings.tones[key] || !g.fm.fileExists(g.image(key))) return null;
  w.backgroundImage = g.fm.readImage(g.image(key));
  return g.settings.tones[key];
}

// Default panel when no glass is set: soft diagonal sheen with a brighter top edge.
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

// All-day events: one faint outlined box per day ("Grandma visiting  +1"),
// quieter than the timed-event blocks.
const PILL_H = 20;
function allDayPill(parent, list, width) {
  if (!list.length) return 0;
  const pill = parent.addStack();
  pill.size = new Size(width, PILL_H);
  pill.cornerRadius = 5;
  pill.backgroundColor = C.allDay;
  pill.borderColor = C.allDayEdge;
  pill.borderWidth = 1;
  pill.setPadding(0, 7, 0, 7);
  pill.centerAlignContent();
  text(pill, list[0].title, { size: 11.5, weight: 'medium', color: C.secondary });
  if (list.length > 1) { pill.addSpacer(4); text(pill, `+${list.length - 1}`, { size: 11, color: C.tertiary }); }
  pill.addSpacer();
  return PILL_H;
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

// Wedding: the one thing that should jump out. Solid inverted block with a
// "WEDDING" label, even for all-day events.
const WED_H = 42;
function weddingBlock(parent, ev, width, { titleLines = 1 } = {}) {
  const height = WED_H + (titleLines - 1) * 16;
  const block = parent.addStack();
  block.size = new Size(width, height);
  block.cornerRadius = 7;
  block.backgroundColor = C.wed;
  block.setPadding(0, 9, 0, 8);
  block.centerAlignContent();
  const body = block.addStack();
  body.layoutVertically();
  const when = ev.allDay ? 'ALL DAY' : timeRange(ev.s, ev.e);
  text(body, `♥ WEDDING · ${when}`, { size: 9.5, weight: 'bold', color: C.wedMuted });
  body.addSpacer(1);
  text(body, ev.title, { size: 13.5, weight: 'bold', color: C.wedText, lines: titleLines });
  block.addSpacer();
  return height;
}

// Footer strip on the large widget for the next wedding beyond the visible week.
function nextWeddingStrip(parent, wedding, now, width) {
  const s = parse(wedding.start, wedding.allDay);
  const n = Math.round((startOfDay(s) - startOfDay(now)) / 86400000);
  const strip = parent.addStack();
  strip.size = new Size(width, 24);
  strip.cornerRadius = 6;
  strip.backgroundColor = C.wed;
  strip.setPadding(0, 9, 0, 9);
  strip.centerAlignContent();
  text(strip, '♥ NEXT WEDDING', { size: 9.5, weight: 'bold', color: C.wedMuted });
  strip.addSpacer(6);
  text(strip, wedding.title, { size: 12, weight: 'bold', color: C.wedText });
  strip.addSpacer();
  text(strip, `${fmt(s, 'MMM d')} · ${n < 14 ? `${n}d` : `${Math.round(n / 7)}w`}`, { size: 11, weight: 'semibold', color: C.wedMuted });
}

// Fills a column top-down within a height budget so nothing gets clipped.
// Each day: label, then the all-day box, then event blocks. Days with only
// all-day events still appear. Today's all-day box can be skipped when the
// layout already shows it next to the date.
function upcoming(col, days, now, width, budget, { skipFirstTimed = 0, skipFirstAllDay = false, skipFirstWeddings = false } = {}) {
  const LABEL = 17, GAP = 4, DAY_GAP = 6, BLOCK = 6 + 15 + 13.5;
  let used = 0, first = true, shown = 0, full = false;
  days.forEach(({ day, timed, allDay, weddings, label }, i) => {
    if (full) return;
    const events = i === 0 ? timed.slice(skipFirstTimed) : timed;
    const allDays = i === 0 && skipFirstAllDay ? [] : allDay;
    const weds = i === 0 && skipFirstWeddings ? [] : weddings;
    if (!events.length && !allDays.length && !weds.length) return;
    const firstH = weds.length ? WED_H : allDays.length ? PILL_H : BLOCK;
    if (used + (first ? 0 : DAY_GAP) + LABEL + firstH > budget) { full = true; return; }
    if (!first) { col.addSpacer(DAY_GAP); used += DAY_GAP; }
    first = false;
    text(col, label || dayLabel(day, now), { size: 10.5, weight: 'semibold', color: C.secondary });
    col.addSpacer(3);
    used += LABEL;
    for (const ev of weds) {
      if (used + WED_H > budget) { full = true; return; }
      used += weddingBlock(col, ev, width) + GAP;
      col.addSpacer(GAP);
      shown++;
    }
    if (allDays.length && used + PILL_H <= budget) {
      used += allDayPill(col, allDays, width) + GAP;
      col.addSpacer(GAP);
      shown++;
    }
    for (const ev of events) {
      const h = BLOCK + (ev.location ? 13.5 : 0);
      if (used + h > budget) {
        if (used + BLOCK <= budget) { used += eventBlock(col, ev, now, width, { location: false }) + GAP; col.addSpacer(GAP); shown++; }
        full = true;
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
  if (today.weddings.length) {
    // A wedding today takes the small widget over.
    weddingBlock(w, today.weddings[0], inner, { titleLines: 2 });
    const rest = today.timed.length + today.allDay.length + today.weddings.length - 1;
    if (rest) { w.addSpacer(4); text(w, `+${rest} more today`, { size: 11, color: C.tertiary }); }
    w.addSpacer();
    return;
  }
  if (today.allDay.length) { allDayPill(w, today.allDay, inner); w.addSpacer(4); }
  if (today.timed.length) {
    // With an all-day box above, the title gets one line so both fit.
    eventBlock(w, today.timed[0], now, inner, { location: false, titleLines: today.allDay.length ? 1 : 2 });
    if (today.timed.length > 1) { w.addSpacer(4); text(w, `+${today.timed.length - 1} more today`, { size: 11, color: C.tertiary }); }
  } else {
    const next = days.slice(1).find(d => d.timed.length || d.allDay.length || d.weddings.length);
    if (next) {
      if (!today.allDay.length) w.addSpacer(2);
      text(w, dayLabel(next.day, now), { size: 10, weight: 'semibold', color: C.secondary });
      w.addSpacer(2);
      if (next.weddings.length) weddingBlock(w, next.weddings[0], inner, { titleLines: 2 });
      else if (next.timed.length) eventBlock(w, next.timed[0], now, inner, { location: false });
      else allDayPill(w, next.allDay, inner);
    } else if (!today.allDay.length) {
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
  let leftBudget = 68;
  // Today's wedding goes right under the date (one fits; more spill to the right).
  let wedsOnLeft = 0;
  if (today.weddings.length) { weddingBlock(left, today.weddings[0], colW); left.addSpacer(4); leftBudget -= WED_H + 4; wedsOnLeft = 1; }
  if (today.allDay.length && leftBudget >= PILL_H + 4) { allDayPill(left, today.allDay, colW); left.addSpacer(4); leftBudget -= PILL_H + 4; }
  let used = 0;
  for (const ev of today.timed) {
    const h = 6 + 15 + 13.5;
    if (used + h > leftBudget) break;
    used += eventBlock(left, ev, now, colW, { location: false }) + 4;
    left.addSpacer(4);
    onLeft++;
  }
  if (!today.timed.length && !today.allDay.length && !today.weddings.length) text(left, EMPTY_TODAY, { size: 12, color: C.secondary, lines: 2 });
  left.addSpacer();

  row.addSpacer(14);

  // Right: what comes after.
  const right = row.addStack();
  right.layoutVertically();
  right.size = new Size(colW, 0);
  const rightDays = [{ ...days[0], weddings: days[0].weddings.slice(wedsOnLeft) }, ...days.slice(1)];
  const shown = upcoming(right, rightDays, now, colW, 128, { skipFirstTimed: onLeft, skipFirstAllDay: true });
  if (!shown) text(right, 'Nothing else this week', { size: 12, color: C.secondary, lines: 2 });
  right.addSpacer();
}

function large(w, days, now, stale, upcomingWeddings = []) {
  const inner = widgetWidth('medium') - PAD * 2;
  dateHeader(w, now, stale, { big: 38 });
  w.addSpacer(2);
  const allDayH = allDayPill(w, days[0].allDay, inner);
  w.addSpacer(8);
  // Next wedding past the visible week gets a strip at the bottom.
  const lastDay = days[days.length - 1].day;
  const later = upcomingWeddings.find(x => startOfDay(parse(x.start, x.allDay)) > lastDay);
  const list = w.addStack();
  list.layoutVertically();
  // The large widget lists today too, so it reads "TODAY" rather than "LATER TODAY".
  const shown = upcoming(list, [{ ...days[0], label: 'TODAY' }, ...days.slice(1)], now, inner, 246 - allDayH - (later ? 30 : 0), { skipFirstAllDay: true });
  if (!shown) text(list, 'Nothing on the calendar this week', { size: 13, color: C.secondary });
  w.addSpacer();
  if (later) nextWeddingStrip(w, later, now, inner);
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

function render(w, family, result, now, parameter) {
  const isLock = family.startsWith('accessory');
  if (!isLock) {
    const tone = applyGlass(w, family, parameter);
    C = palette(tone || 'auto');
    if (!tone) glass(w);
    w.setPadding(PAD, PAD, PAD - 2, PAD);
  }
  if (result.error) {
    text(w, result.error, { size: isLock ? 12 : 13, color: isLock ? Color.white() : C.secondary, lines: 4 });
    return;
  }
  const days = buildDays(result.data.events, now, 7);
  if (isLock) lockScreen(w, days, now);
  else if (family === 'small') small(w, days, now, result.stale);
  else if (family === 'medium') medium(w, days, now, result.stale);
  else large(w, days, now, result.stale, result.data.upcomingWeddings);
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
  render(w, family, result, now, args.widgetParameter);
  Script.setWidget(w);
} else {
  // In the app: preview each size, set up the glass background, or change the token.
  const menu = new Alert();
  menu.title = 'Agenda widget';
  menu.addAction('Preview small');
  menu.addAction('Preview medium');
  menu.addAction('Preview large');
  menu.addAction('Frosted wallpaper background…');
  menu.addAction('Remove frosted background…');
  menu.addAction('Change token');
  menu.addCancelAction('Done');
  const pick = await menu.presentSheet();
  if (pick === 3) {
    await setUpGlass();
  } else if (pick === 4) {
    await removeGlass();
  } else if (pick === 5) {
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
