/** Tests for the date helpers that drive the range-partitioning crawler. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, brDateTimeToIso, brToIso, daysInRange, isoToBr, splitRange } from '../util/dates';

test('converts between ISO and the portal dd/MM/yyyy format', () => {
  assert.equal(isoToBr('2020-01-15'), '15/01/2020');
  assert.equal(brToIso('15/01/2020'), '2020-01-15');
  assert.equal(brToIso('not a date'), undefined);
});

test('extracts an ISO timestamp from a movement label', () => {
  assert.equal(brDateTimeToIso('Baixa Definitiva (02/02/2023 18:27:05)'), '2023-02-02T18:27:05');
  assert.equal(brDateTimeToIso('Distribuído em 17/10/2006'), '2006-10-17');
  assert.equal(brDateTimeToIso('no date here'), undefined);
});

test('counts days inclusively', () => {
  assert.equal(daysInRange({ from: '2020-01-01', to: '2020-01-01' }), 1);
  assert.equal(daysInRange({ from: '2020-01-01', to: '2020-01-31' }), 31);
  assert.equal(daysInRange({ from: '2020-01-01', to: '2020-12-31' }), 366); // leap year
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2020-01-31', 1), '2020-02-01');
  assert.equal(addDays('2020-12-31', 1), '2021-01-01');
});

test('splitRange halves a range into two contiguous, non-overlapping halves', () => {
  const [a, b] = splitRange({ from: '2020-01-01', to: '2020-01-10' });
  assert.equal(a.from, '2020-01-01');
  assert.equal(addDays(a.to, 1), b.from);
  assert.equal(b.to, '2020-01-10');
  assert.equal(daysInRange(a) + daysInRange(b), 10);
});

test('splitRange refuses a single day', () => {
  assert.throws(() => splitRange({ from: '2020-01-01', to: '2020-01-01' }));
});
