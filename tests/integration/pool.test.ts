import { startBackend, stopBackend, resetData, models, createServiceAccount, createUser, past } from './harness';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JobStatus } from '../../src/models/UrlJob';
import { apiUsageService } from '../../src/services/apiUsageService';
import { serviceAccountPool } from '../../src/services/serviceAccountPool';
import { getNextPacificMidnight } from '../../src/utils/helpers';

const { ServiceAccount, ApiUsage, UrlJob } = models;

describe('quota & data-integrity primitives — real MongoDB', () => {
  before(startBackend);
  after(stopBackend);
  beforeEach(resetData);

  it('shared daily budget is atomic: 25 concurrent takers on a budget of 5 → exactly 5 succeed', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => apiUsageService.tryConsume('oauth-publish', 5))
    );
    assert.equal(results.filter(Boolean).length, 5);
    assert.equal((await ApiUsage.findOne())!.count, 5);
    assert.equal(await apiUsageService.isExhausted('oauth-publish', 5), true);
  });

  it('marking a budget exhausted blocks it, and other budgets are unaffected', async () => {
    await apiUsageService.markExhausted('oauth-publish', 180);
    assert.equal(await apiUsageService.tryConsume('oauth-publish', 180), false);
    assert.equal(await apiUsageService.isExhausted('oauth-publish', 180), true);
    assert.equal(await apiUsageService.tryConsume('something-else', 180), true);
  });

  it('usage rows expire by themselves (TTL index) and are keyed per Pacific day', async () => {
    await apiUsageService.tryConsume('oauth-publish', 5);
    const indexes = await ApiUsage.collection.indexes();
    assert.ok(
      indexes.some((i) => i.key.expiresAt === 1 && i.expireAfterSeconds === 0),
      'TTL index on expiresAt exists'
    );
    const row = await ApiUsage.findOne();
    assert.match(row!.key, /^oauth-publish:\d{4}-\d{2}-\d{2}$/);
    assert.ok(row!.expiresAt.getTime() > getNextPacificMidnight().getTime());
  });

  it('service-account pool: picks the least-used account, only publishing spends quota', async () => {
    const busy = await createServiceAccount({ dailyQuotaUsed: 50 });
    const idle = await createServiceAccount({ dailyQuotaUsed: 3 });

    const peek = await serviceAccountPool.getAvailable(false);
    assert.equal(peek!.email, idle.email);
    assert.equal((await ServiceAccount.findById(idle._id))!.dailyQuotaUsed, 3, 'peeking does not spend quota');

    const taken = await serviceAccountPool.getAvailable();
    assert.equal(taken!.email, idle.email);
    assert.equal((await ServiceAccount.findById(idle._id))!.dailyQuotaUsed, 4);
    assert.equal((await ServiceAccount.findById(busy._id))!.dailyQuotaUsed, 50);
  });

  it('service-account pool: exhausted accounts are skipped; exhaustion is reported only when nothing is left', async () => {
    const spent = await createServiceAccount({ dailyQuotaUsed: 180, dailyQuotaLimit: 180 });
    assert.equal(await serviceAccountPool.getAvailable(), null);
    assert.equal(await serviceAccountPool.isQuotaExhausted(), true);

    const fresh = await createServiceAccount();
    assert.equal((await serviceAccountPool.getAvailable())!.email, fresh.email);

    await serviceAccountPool.markQuotaExhausted(fresh._id.toString());
    assert.equal(await serviceAccountPool.isQuotaExhausted(), true);
    assert.equal((await ServiceAccount.findById(spent._id))!.isActive, true);
  });

  it('service-account pool: a missing account is never reported as "quota exhausted"', async () => {
    assert.equal(await serviceAccountPool.isQuotaExhausted(), false);
    assert.equal(await serviceAccountPool.getAvailable(), null);
  });

  it('service-account pool: quota resets at the next Pacific midnight, not UTC', async () => {
    const sa = await createServiceAccount({ dailyQuotaUsed: 180, quotaResetAt: past() });
    const taken = await serviceAccountPool.getAvailable();
    assert.equal(taken!.email, sa.email);

    const after = await ServiceAccount.findById(sa._id);
    assert.equal(after!.dailyQuotaUsed, 1, 'reset to 0, then this call used 1');
    assert.equal(after!.quotaResetAt.getTime(), getNextPacificMidnight().getTime());
  });

  it('service-account pool: only real errors deactivate an account (5 in a row)', async () => {
    const sa = await createServiceAccount();
    for (let i = 0; i < 4; i++) await serviceAccountPool.reportError(sa._id.toString(), 'boom');
    assert.equal((await ServiceAccount.findById(sa._id))!.isActive, true);
    await serviceAccountPool.reportError(sa._id.toString(), 'boom');
    assert.equal((await ServiceAccount.findById(sa._id))!.isActive, false);
  });

  it('a user cannot have two active jobs for the same URL — enforced by the database itself', async () => {
    const user = await createUser();
    const base = { userId: user._id, originalUrl: 'https://customer.com/a', domain: 'customer.com' };

    await UrlJob.create({ ...base, status: JobStatus.QUEUED });
    await assert.rejects(UrlJob.create({ ...base, status: JobStatus.PENDING }), { code: 11000 });

    await UrlJob.updateOne({ ...base }, { status: JobStatus.FAILED });
    await UrlJob.create({ ...base, status: JobStatus.QUEUED }); // allowed again after it ended
    assert.equal(await UrlJob.countDocuments(base), 2);
  });
});
