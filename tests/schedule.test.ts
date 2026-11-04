import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRetryWaitOver,
  isStatusCheckDue,
  retryDueCutoff,
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

// ─── Retry cadence ──────────────────────────────────────────────────────

/**
 * Runs the retry cron over `days` days against one job that is always still not indexed and returns
 * when each retry happened. A retry is recorded `processingMs` after its tick, as in production.
 */
function simulateRetries(opts: { tickMs: number; minWaitMs: number; days: number; processingMs: number; slack: boolean }): number[] {
  const retries: number[] = [];
  let last = at(0); // the Indexing API call
  for (let now = T0 + opts.tickMs; now <= T0 + opts.days * 24 * HOUR; now += opts.tickMs) {
    const due = opts.slack
      ? isRetryWaitOver({ now, since: last, minWaitMs: opts.minWaitMs })
      : now - last.getTime() >= opts.minWaitMs;
    if (!due) continue;
    last = new Date(now + opts.processingMs);
    retries.push(last.getTime());
  }
  return retries;
}

const gaps = (times: number[]): number[] => times.slice(1).map((t, i) => t - times[i]);

test('retry: with a 30-minute cron and a few minutes of slack, a 6 hour wait really is 6 hours', () => {
  const retries = simulateRetries({ tickMs: 30 * MIN, minWaitMs: 6 * HOUR, days: 7, processingMs: 3_000, slack: true });
  assert.ok(gaps(retries).every((gap) => gap === 6 * HOUR), `gaps in hours: ${gaps(retries).map((g) => g / HOUR)}`);
  assert.ok(retries.length >= 27, `retries in 7 days: ${retries.length}`);
  assert.ok(retries[0] - T0 <= 6 * HOUR + 30 * MIN, 'the first retry comes within one tick of the wait');
});

test('retry: without the slack a retried job slips a whole tick every time (the bug this fixes)', () => {
  const retries = simulateRetries({ tickMs: 30 * MIN, minWaitMs: 6 * HOUR, days: 7, processingMs: 3_000, slack: false });
  assert.ok(gaps(retries).every((gap) => gap === 6 * HOUR + 30 * MIN), 'every gap is 6.5h');

  // and with the old 6-hour cron and no slack, 6 hours became 12
  const old = simulateRetries({ tickMs: 6 * HOUR, minWaitMs: 6 * HOUR, days: 7, processingMs: 3_000, slack: false });
  assert.ok(gaps(old).every((gap) => gap === 12 * HOUR), 'every gap is 12h');
});

test('retry: the 24 hour default stays at 24 hours', () => {
  const retries = simulateRetries({ tickMs: 30 * MIN, minWaitMs: 24 * HOUR, days: 14, processingMs: 3_000, slack: true });
  assert.ok(gaps(retries).every((gap) => gap === 24 * HOUR));
});

test('retry: isRetryWaitOver and retryDueCutoff agree, and the slack is 5 minutes', () => {
  const since = at(0);
  const wait = 6 * HOUR;
  assert.equal(isRetryWaitOver({ now: T0 + wait - 5 * MIN - 1, since, minWaitMs: wait }), false);
  assert.equal(isRetryWaitOver({ now: T0 + wait - 5 * MIN, since, minWaitMs: wait }), true);
  const now = T0 + 10 * HOUR;
  assert.equal(retryDueCutoff(now, wait).getTime(), now - wait + 5 * MIN);
  // a job is due exactly when its last attempt is at or before the cutoff
  const cutoff = retryDueCutoff(now, wait);
  assert.equal(isRetryWaitOver({ now, since: cutoff, minWaitMs: wait }), true);
  assert.equal(isRetryWaitOver({ now, since: new Date(cutoff.getTime() + 1), minWaitMs: wait }), false);
});
