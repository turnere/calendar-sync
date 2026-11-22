import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyGroups, markWeddings, toItem } from '../src/agenda-merge.js';

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
