/**
 * Decides what to do next for a job whose wrappers are live but whose page is not indexed yet.
 * Pure on purpose: the cron in services/recrawlService.ts gathers the facts, this decides.
 *
 *  1. NUDGE        a wrapper Googlebot has not fetched, notified long enough ago → refresh + notify again
 *  2. ADD_WRAPPER  every wrapper was fetched or is out of nudges, and the newest is old enough → one more wrapper
 *  3. NONE         wait
 */

const HOUR = 60 * 60 * 1000;

export interface PlanWrapper {
  wrapperId: string;
  createdAt: Date;
  crawledAt: Date | null;
  /** Successful Indexing API notifications, the first publish included */
  notifyCount: number;
  lastNotifiedAt: Date | null;
}

export interface RecrawlLimits {
  nudgeAfterHours: number;
  maxNudgesPerWrapper: number;
  extraWrapperAfterHours: number;
  maxWrappersPerJob: number;
}

export type RecrawlAction =
  | { type: 'NUDGE'; wrapperId: string }
  | { type: 'ADD_WRAPPER' }
  | { type: 'NONE' };

export function planRecrawl(
  wrappers: PlanWrapper[],
  limits: RecrawlLimits,
  now: number = Date.now()
): RecrawlAction {
  if (wrappers.length === 0) return { type: 'NONE' };

  const nudgeAfterMs = limits.nudgeAfterHours * HOUR;
  const nudgeable = wrappers
    .filter((w) => {
      if (w.crawledAt) return false; // Googlebot already fetched it: another ping adds nothing
      if (!w.lastNotifiedAt) return false; // never notified (publish pending/deferred): not ours to nudge
      if (w.notifyCount - 1 >= limits.maxNudgesPerWrapper) return false;
      return now - w.lastNotifiedAt.getTime() >= nudgeAfterMs;
    })
    .sort((a, b) => a.lastNotifiedAt!.getTime() - b.lastNotifiedAt!.getTime());
  if (nudgeable.length > 0) return { type: 'NUDGE', wrapperId: nudgeable[0].wrapperId };

  if (wrappers.length < limits.maxWrappersPerJob) {
    const newest = Math.max(...wrappers.map((w) => w.createdAt.getTime()));
    if (now - newest >= limits.extraWrapperAfterHours * HOUR) return { type: 'ADD_WRAPPER' };
  }

  return { type: 'NONE' };
}
