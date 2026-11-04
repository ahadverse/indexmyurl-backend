import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanWrapper, RecrawlLimits, planRecrawl } from '../src/utils/recrawlPlan';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-04T12:00:00Z');
const ago = (hours: number): Date => new Date(NOW - hours * HOUR);

const LIMITS: RecrawlLimits = {
  nudgeAfterHours: 6,
  maxNudgesPerWrapper: 2,
  extraWrapperAfterHours: 12,
  maxWrappersPerJob: 2,
};

const wrapper = (over: Partial<PlanWrapper> & { wrapperId: string }): PlanWrapper => ({
  createdAt: ago(1),
  crawledAt: null,
  notifyCount: 1,
  lastNotifiedAt: ago(1),
  ...over,
});

test('recrawl: nothing to do without live wrappers', () => {
  assert.deepEqual(planRecrawl([], LIMITS, NOW), { type: 'NONE' });
});

test('recrawl: a fresh wrapper is left alone', () => {
  assert.deepEqual(planRecrawl([wrapper({ wrapperId: 'a' })], LIMITS, NOW), { type: 'NONE' });
});

test('recrawl: an unfetched wrapper is nudged once it has waited long enough', () => {
  const w = wrapper({ wrapperId: 'a', createdAt: ago(7), lastNotifiedAt: ago(6) });
  assert.deepEqual(planRecrawl([w], LIMITS, NOW), { type: 'NUDGE', wrapperId: 'a' });
  assert.deepEqual(planRecrawl([{ ...w, lastNotifiedAt: ago(5.9) }], LIMITS, NOW), { type: 'NONE' });
});

test('recrawl: a wrapper Googlebot already fetched is never nudged', () => {
  const w = wrapper({ wrapperId: 'a', createdAt: ago(8), lastNotifiedAt: ago(8), crawledAt: ago(2) });
  assert.deepEqual(planRecrawl([w], LIMITS, NOW), { type: 'NONE' });
});

test('recrawl: a wrapper that was never notified is not ours to nudge', () => {
  const w = wrapper({ wrapperId: 'a', createdAt: ago(8), lastNotifiedAt: null, notifyCount: 0 });
  assert.deepEqual(planRecrawl([w], LIMITS, NOW), { type: 'NONE' });
});

test('recrawl: stops nudging after the allowed number of extra notifications', () => {
  const base = { wrapperId: 'a', createdAt: ago(30), lastNotifiedAt: ago(7) };
  assert.deepEqual(planRecrawl([wrapper({ ...base, notifyCount: 2 })], LIMITS, NOW), { type: 'NUDGE', wrapperId: 'a' });
  // notifyCount 3 = the first publish + 2 nudges: this wrapper is used up, so the job gets a new one instead
  assert.deepEqual(planRecrawl([wrapper({ ...base, notifyCount: 3 })], LIMITS, NOW), { type: 'ADD_WRAPPER' });
  assert.deepEqual(
    planRecrawl([wrapper({ ...base, notifyCount: 3 })], { ...LIMITS, maxWrappersPerJob: 1 }, NOW),
    { type: 'NONE' }
  );
});

test('recrawl: the wrapper that has waited longest is nudged first', () => {
  const a = wrapper({ wrapperId: 'a', createdAt: ago(20), lastNotifiedAt: ago(7) });
  const b = wrapper({ wrapperId: 'b', createdAt: ago(20), lastNotifiedAt: ago(9) });
  assert.deepEqual(planRecrawl([a, b], LIMITS, NOW), { type: 'NUDGE', wrapperId: 'b' });
});

test('recrawl: an extra wrapper is added once the newest one is old enough, up to the limit', () => {
  const crawled = (id: string, createdHoursAgo: number): PlanWrapper =>
    wrapper({ wrapperId: id, createdAt: ago(createdHoursAgo), lastNotifiedAt: ago(createdHoursAgo), crawledAt: ago(1) });

  assert.deepEqual(planRecrawl([crawled('a', 11.9)], LIMITS, NOW), { type: 'NONE' });
  assert.deepEqual(planRecrawl([crawled('a', 12)], LIMITS, NOW), { type: 'ADD_WRAPPER' });
  // the limit counts the first wrapper
  assert.deepEqual(planRecrawl([crawled('a', 40), crawled('b', 30)], LIMITS, NOW), { type: 'NONE' });
  assert.deepEqual(
    planRecrawl([crawled('a', 40), crawled('b', 30)], { ...LIMITS, maxWrappersPerJob: 3 }, NOW),
    { type: 'ADD_WRAPPER' }
  );
  // age is measured from the NEWEST wrapper, so a recent extra delays the next one
  assert.deepEqual(
    planRecrawl([crawled('a', 40), crawled('b', 2)], { ...LIMITS, maxWrappersPerJob: 3 }, NOW),
    { type: 'NONE' }
  );
});

test('recrawl: maxWrappersPerJob 1 means never add wrappers', () => {
  const w = wrapper({ wrapperId: 'a', createdAt: ago(100), lastNotifiedAt: ago(100), crawledAt: ago(90) });
  assert.deepEqual(planRecrawl([w], { ...LIMITS, maxWrappersPerJob: 1 }, NOW), { type: 'NONE' });
});
