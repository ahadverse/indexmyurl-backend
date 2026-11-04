const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// Cron ticks and per-job processing time jitter by a few minutes; without
// some slack a check due at "30 min" would slip to the next tick.
const DUE_SLACK_MS = 5 * MINUTE;

/**
 * Wait between two status checks, by job age. Checks are frequent early
 * (when indexing is most likely) and back off so a long-waiting job does not
 * burn the Search Console URL Inspection quota.
 */
export function statusCheckIntervalMs(ageMs: number): number {
  if (ageMs < 6 * HOUR) return 30 * MINUTE;
  if (ageMs < 24 * HOUR) return 2 * HOUR;
  return 6 * HOUR;
}

export function isStatusCheckDue(opts: {
  now: number;
  startedAt: Date;
  lastCheckedAt: Date | null | undefined;
  firstCheckAfterMs: number;
}): boolean {
  const age = opts.now - opts.startedAt.getTime();
  if (age < opts.firstCheckAfterMs) return false;
  if (!opts.lastCheckedAt) return true;
  const sinceLast = opts.now - opts.lastCheckedAt.getTime();
  return sinceLast >= statusCheckIntervalMs(age) - DUE_SLACK_MS;
}

/**
 * Has a retry's minimum wait passed? `since` is the last attempt (the Indexing API call, or the
 * previous retry). The same few minutes of slack as the status checks: a retry is recorded a few
 * seconds after the cron tick that started it, so without slack a job due "6 hours after the last
 * retry" would just miss the tick 6 hours later and wait for the next one.
 */
export function isRetryWaitOver(opts: { now: number; since: Date; minWaitMs: number }): boolean {
  return opts.now - opts.since.getTime() >= opts.minWaitMs - DUE_SLACK_MS;
}

/** Jobs whose last attempt is at or before this instant have waited long enough (see isRetryWaitOver). */
export function retryDueCutoff(now: number, minWaitMs: number): Date {
  return new Date(now - minWaitMs + DUE_SLACK_MS);
}

/** Backoff before re-trying a failed Indexing API call: 5, 10, 20, 40, then 60 min. */
export function publishRetryDelayMs(attempts: number): number {
  return Math.min(5 * MINUTE * 2 ** Math.max(0, attempts - 1), 60 * MINUTE);
}
