import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agendaWindow, applyGroups, markWeddings, parseFromDate, toItem } from '../src/agenda-merge.js';

const weddingCalendars = new Set(['HoneyBook']);
const start = '2027-01-12T18:00:00Z';

function event(id, title, calendar = 'HoneyBook') {
  return toItem({ id, summary: title, start: { dateTime: start }, _calendarName: calendar });
}

test('touch-base appointments from the wedding calendar stay in the agenda as regular events', () => {
  const items = markWeddings([
    event('meeting', 'Jamie Rivera - Touch Base Wedding'),
    event('hyphenated', 'Jamie Rivera - Touch-Base'),
    event('wedding', 'Jamie and Taylor'),
  ], weddingCalendars);

  assert.deepEqual(items.map(({ id, wedding }) => ({ id, wedding })), [
    { id: 'meeting', wedding: false },
    { id: 'hyphenated', wedding: false },
    { id: 'wedding', wedding: true },
  ]);
});

test('a merged touch-base appointment keeps its regular event classification', () => {
  const items = [
    event('meeting', 'Jamie - Touch Base'),
    event('copy', 'Jamie Rivera and Taylor Smith Wedding', 'Primary'),
  ];
  const merged = applyGroups(items, [{ ids: ['meeting', 'copy'], reason: 'same appointment' }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'copy');
  assert.equal(markWeddings(merged, weddingCalendars)[0].wedding, false);
});

test('a requested start date must be a real date within about three years', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  assert.equal(parseFromDate('2027-03-28', now), '2027-03-28');
  assert.equal(parseFromDate('2026-01-01', now), '2026-01-01');
  for (const bad of [undefined, '', '2027-3-1', '2027-02-30', '2031-01-01', ['2027-03-28']]) {
    assert.equal(parseFromDate(bad, now), null, String(bad));
  }
});

test('the agenda window follows the requested start date', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  const iso = ({ from, to }) => [new Date(from).toISOString(), new Date(to).toISOString()];
  assert.deepEqual(iso(agendaWindow(42, '2027-03-28', now)), ['2027-03-27T00:00:00.000Z', '2027-05-10T00:00:00.000Z']);
  assert.deepEqual(iso(agendaWindow(60, null, now)), ['2026-11-26T12:00:00.000Z', '2027-01-26T12:00:00.000Z']);
});
