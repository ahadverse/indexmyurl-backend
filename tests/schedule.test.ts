import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isStatusCheckDue,
  publishRetryDelayMs,
  statusCheckIntervalMs,
} from '../src/utils/schedule';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-29T00:00:00Z');
const at = (offsetMs: number): Date => new Date(T0 + offsetMs);

test('check interval backs off with job age', () => {
  assert.equal(statusCheckIntervalMs(1 * HOUR), 30 * MIN);
  assert.equal(statusCheckIntervalMs(6 * HOUR), 2 * HOUR);
  assert.equal(statusCheckIntervalMs(23 * HOUR), 2 * HOUR);
  assert.equal(statusCheckIntervalMs(24 * HOUR), 6 * HOUR);
  assert.equal(statusCheckIntervalMs(5 * 24 * HOUR), 6 * HOUR);
});

test('no check before the first-check delay', () => {
  const base = { startedAt: at(0), lastCheckedAt: null, firstCheckAfterMs: 20 * MIN };
  assert.equal(isStatusCheckDue({ ...base, now: at(19 * MIN).getTime() }), false);
  assert.equal(isStatusCheckDue({ ...base, now: at(20 * MIN).getTime() }), true);
});

test('after the first check, waits for the interval (with slack)', () => {
  const base = { startedAt: at(0), firstCheckAfterMs: 20 * MIN, lastCheckedAt: at(20 * MIN) };
  assert.equal(isStatusCheckDue({ ...base, now: at(40 * MIN).getTime() }), false);
  assert.equal(isStatusCheckDue({ ...base, now: at(45 * MIN).getTime() }), true);
});

test('old jobs are checked every ~6 hours', () => {
  const base = { startedAt: at(0), firstCheckAfterMs: 20 * MIN, lastCheckedAt: at(48 * HOUR) };
  assert.equal(isStatusCheckDue({ ...base, now: at(52 * HOUR).getTime() }), false);
  assert.equal(isStatusCheckDue({ ...base, now: at(54 * HOUR).getTime() }), true);
});

test('publish retry backoff doubles and caps at 60 minutes', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 9].map((n) => publishRetryDelayMs(n) / MIN),
    [5, 10, 20, 40, 60, 60]
  );
});
