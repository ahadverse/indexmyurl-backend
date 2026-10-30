import {
  startBackend, stopBackend, resetData, stopCron, google, reply, inspect, models,
  createUser, createServiceAccount, connectGoogle, waitFor, waitForStatus, queueIdle,
  sleep, past, WEBMASTERS_READONLY,
} from './harness';
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../../src/config/env';
import { JobStatus } from '../../src/models/UrlJob';
import { indexingQueue } from '../../src/config/queue';
import { jobOrchestrator } from '../../src/services/jobOrchestratorService';
import { retryService } from '../../src/services/retryService';
import { wrapperService } from '../../src/services/wrapperService';
import { sitemapService } from '../../src/services/sitemapService';
import { queueService } from '../../src/services/queueService';
import { startIndexCheckJob } from '../../src/jobs/cronJobs';
import { getNextPacificMidnight } from '../../src/utils/helpers';

const { User, UrlJob, ServiceAccount, WrapperPage, DomainActivity, GoogleToken, ApiUsage } = models;

const URL1 = 'https://customer.com/blog/post-1';
const URL2 = 'https://customer.com/blog/post-2';
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

const oid = (s: string | undefined) => new mongoose.Types.ObjectId(s);
const submit = (user: { _id: mongoose.Types.ObjectId }, url: string) =>
  jobOrchestrator.submitUrl(url, user._id);

/** Submit and return the job id (asserting the submission was accepted). */
async function submitOk(user: { _id: mongoose.Types.ObjectId }, url = URL1) {
  const res = await submit(user, url);
  assert.equal(res.success, true, res.message);
  return oid(res.jobId);
}

const deferred = (id: mongoose.Types.ObjectId) =>
  waitFor(async () => {
    const job = await UrlJob.findById(id);
    return job?.nextPublishAt ? job : null;
  }, `job ${id} to be deferred`);

describe('indexing pipeline — real MongoDB + Redis, fake Google', () => {
  before(startBackend);
  after(stopBackend);
  beforeEach(resetData);

  // ─── The main flow ──────────────────────────────────────────────────

  it('submit → queue → wrapper → Indexing API → confirmed indexed → credit charged', async () => {
    const user = await createUser({ credits: 5 });
    const sa = await createServiceAccount();

    const res = await submit(user, URL1);
    assert.equal(res.success, true);
    assert.equal(res.status, JobStatus.QUEUED);
    const id = oid(res.jobId);

    // credit is reserved immediately, not charged
    let u = await User.findById(user._id);
    assert.deepEqual([u!.credits, u!.reservedCredits], [5, 1]);

    const job = await waitForStatus(id, JobStatus.WAITING_CRAWL);
    assert.equal(job.credentialSource, 'SERVICE_ACCOUNT');
    assert.match(job.wrapperUrl!, /^https:\/\/indexer\.test\/job\/[a-f0-9]{20}$/);
    assert.ok(job.apiCalledAt);

    // exactly one publish, for the wrapper URL, with the service account's token
    assert.equal(google.publishCalls.length, 1);
    assert.deepEqual(google.publishCalls[0], {
      url: job.wrapperUrl,
      type: 'URL_UPDATED',
      token: `sa-token:${sa.email}`,
    });

    // the wrapper page that Googlebot would fetch
    const page = await wrapperService.serveWrapper(job.wrapperId!);
    assert.equal(page!.isActive, true);
    assert.match(page!.html, /"@type": "JobPosting"/);
    assert.ok(page!.html.includes(`<link rel="canonical" href="${URL1}" />`));
    assert.ok(page!.html.includes('content="index, follow"'));

    // secondary signals: sitemap contains it and was submitted via Search Console
    await waitFor(async () => google.sitemapCalls.length >= 2, 'sitemap submission');
    assert.ok((await sitemapService.getCurrentSitemap()).includes(job.wrapperUrl!));
    assert.deepEqual(
      google.sitemapCalls.map((c) => c.feed).sort(),
      ['https://indexer.test/rss.xml', 'https://indexer.test/sitemap.xml']
    );
    assert.equal(google.sitemapCalls[0].siteUrl, 'https://indexer.test/');

    // Inspections (pre-check + worker re-check) must NOT spend publish quota; only the publish did
    assert.ok(google.inspectCalls.length >= 2);
    assert.equal((await ServiceAccount.findById(sa._id))!.dailyQuotaUsed, 1);

    // Google now reports it indexed → credit is charged, wrapper retired
    google.onInspect = () => inspect.indexed;
    await jobOrchestrator.checkAndHandleStatus(id);

    const done = await UrlJob.findById(id);
    assert.equal(done!.status, JobStatus.INDEXED);
    assert.ok(done!.indexedAt && done!.creditDeductedAt);
    u = await User.findById(user._id);
    assert.deepEqual([u!.credits, u!.reservedCredits], [4, 0]);
    assert.equal((await WrapperPage.findOne({ wrapperId: job.wrapperId }))!.status, 'NOINDEX');
    assert.equal((await DomainActivity.findOne({ domain: 'customer.com' }))!.activeJobCount, 0);

    // success handling is idempotent: running it again must not charge twice
    await jobOrchestrator.handleSuccess(id);
    assert.equal((await User.findById(user._id))!.credits, 4);

    assert.deepEqual(google.blockedCalls, [], 'no request may leave the fake Google edge');
  });

  it('already indexed at submit time: no credit, no job in the queue', async () => {
    const user = await createUser();
    await connectGoogle(user);
    google.onInspect = () => inspect.indexed;

    const res = await submit(user, URL1);
    assert.equal(res.alreadyIndexed, true);
    assert.equal(res.status, JobStatus.INDEXED);

    const u = await User.findById(user._id);
    assert.deepEqual([u!.credits, u!.reservedCredits], [5, 0]);
    assert.equal(google.publishCalls.length, 0);
    await queueIdle();
  });

  it('rejects bad submissions without touching credits', async () => {
    const user = await createUser({ credits: 1 });
    await createServiceAccount();

    assert.match((await submit(user, 'ftp://customer.com/x')).message, /Invalid URL/);
    assert.match((await submit(user, 'https://best-casino-site.com/x')).message, /blocked content/);

    const first = await submit(user, URL1);
    assert.equal(first.success, true);
    assert.match((await submit(user, URL1)).message, /already submitted/);
    // the one credit is already reserved
    assert.match((await submit(user, URL2)).message, /Insufficient credits/);

    assert.equal((await User.findById(user._id))!.reservedCredits, 1);
    assert.equal(await UrlJob.countDocuments({ userId: user._id }), 1);
  });

  it('enforces the per-user daily cap', async () => {
    env.queue.userDailyCap = 1;
    const user = await createUser({ credits: 5 });
    await createServiceAccount();
    assert.equal((await submit(user, URL1)).success, true);
    assert.match((await submit(user, URL2)).message, /Daily limit reached/);
  });

  it('is race-safe: concurrent submissions cannot over-spend credits', async () => {
    const user = await createUser({ credits: 1 });
    await createServiceAccount();

    const urls = [1, 2, 3, 4, 5].map((n) => `https://customer.com/p/${n}`);
    const results = await Promise.all(urls.map((u) => submit(user, u)));

    assert.equal(results.filter((r) => r.success).length, 1);
    const u = await User.findById(user._id);
    assert.deepEqual([u!.credits, u!.reservedCredits], [1, 1]);
    assert.equal(await UrlJob.countDocuments({ userId: user._id }), 1);
  });

  it('concurrent duplicate submissions of one URL create ONE job and leak no reserved credit', async () => {
    const user = await createUser({ credits: 5 });
    await createServiceAccount();

    const results = await Promise.all(Array.from({ length: 6 }, () => submit(user, URL1)));

    assert.equal(results.filter((r) => r.success).length, 1);
    assert.equal(await UrlJob.countDocuments({ userId: user._id }), 1);
    const u = await User.findById(user._id);
    assert.deepEqual([u!.credits, u!.reservedCredits], [5, 1], 'only the one real job holds a credit');
  });

  it('a job created but never queued (e.g. Redis was down at submit time) is picked up by recovery', async () => {
    const user = await createUser();
    await createServiceAccount();
    await User.updateOne({ _id: user._id }, { reservedCredits: 1 });
    const job = await UrlJob.create({
      userId: user._id, originalUrl: URL1, domain: 'customer.com',
      status: JobStatus.PENDING, creditReservedAt: past(2 * HOUR),
    });
    // createdAt is immutable through Mongoose, so age the document directly
    await UrlJob.collection.updateOne({ _id: job._id }, { $set: { createdAt: past(2 * HOUR) } });

    assert.equal(await jobOrchestrator.recoverStuckJobs(), 1);
    await waitForStatus(job._id, JobStatus.WAITING_CRAWL);
    assert.equal((await DomainActivity.findOne({ domain: 'customer.com' }))!.activeJobCount, 1);
  });

  // ─── Quota ──────────────────────────────────────────────────────────

  it('Google quota (429): job waits for the Pacific reset, service account stays healthy, then resumes with the SAME wrapper', async () => {
    const user = await createUser();
    const sa = await createServiceAccount();
    google.onPublish = () => reply.status(429, 'Quota exceeded for quota metric');

    const id = await submitOk(user);
    const job = await deferred(id);

    assert.equal(job.status, JobStatus.WRAPPER_CREATED);
    assert.equal(job.publishAttempts, 0, 'a quota wait is not a failed attempt');
    const reset = getNextPacificMidnight().getTime();
    assert.ok(job.nextPublishAt!.getTime() >= reset + MIN - 5000, 'resumes after the reset');
    assert.ok(job.nextPublishAt!.getTime() <= reset + 30 * MIN + 5000, 'within 30 min of the reset');

    const account = await ServiceAccount.findById(sa._id);
    assert.equal(account!.isActive, true);
    assert.equal(account!.consecutiveErrors, 0, '429 must not count as an unhealthy account');
    assert.equal(account!.dailyQuotaUsed, account!.dailyQuotaLimit);

    // Simulate the next day: quota resets, the deferral time arrives, Google accepts
    google.onPublish = () => reply.ok();
    await ServiceAccount.updateOne({ _id: sa._id }, { quotaResetAt: past() });
    await UrlJob.updateOne({ _id: id }, { nextPublishAt: past() });
    assert.equal(await jobOrchestrator.recoverStuckJobs(), 1);

    const resumed = await waitForStatus(id, JobStatus.WAITING_CRAWL);
    assert.equal(await WrapperPage.countDocuments({ jobId: id }), 1, 'wrapper is reused, not duplicated');
    assert.equal(google.publishCalls.length, 2);
    assert.equal(google.publishCalls[0].url, google.publishCalls[1].url);
    assert.equal(resumed.nextPublishAt, null);
    assert.equal((await ServiceAccount.findById(sa._id))!.dailyQuotaUsed, 1, 'quota counter reset');
  });

  it('shared OAuth publish budget: once spent, further jobs wait instead of calling Google', async () => {
    env.google.publishCredentialMode = 'user_first';
    env.google.oauthDailyPublishLimit = 1;
    const user = await createUser();
    await connectGoogle(user);

    const a = await submitOk(user, URL1);
    await waitForStatus(a, JobStatus.WAITING_CRAWL);
    const b = await submitOk(user, URL2);
    const jobB = await deferred(b);

    assert.equal(jobB.publishAttempts, 0);
    assert.equal(google.publishCalls.length, 1, 'the second job never reached Google');
    assert.ok(jobB.nextPublishAt!.getTime() > getNextPacificMidnight().getTime());
    assert.equal((await ApiUsage.findOne())!.count, 1);
  });

  // ─── Credentials ────────────────────────────────────────────────────

  it('service account rejected (403): falls back to the user token and counts one SA error', async () => {
    const user = await createUser();
    const sa = await createServiceAccount();
    await connectGoogle(user);
    google.onPublish = (c) => (c.token.startsWith('sa-token') ? reply.status(403, 'Permission denied') : reply.ok());

    const id = await submitOk(user);
    const job = await waitForStatus(id, JobStatus.WAITING_CRAWL);

    assert.equal(job.credentialSource, 'OAUTH');
    assert.deepEqual(google.publishCalls.map((c) => c.token), [`sa-token:${sa.email}`, 'user-token']);
    assert.equal((await ServiceAccount.findById(sa._id))!.consecutiveErrors, 1);
    assert.equal((await ApiUsage.findOne())!.count, 1);
  });

  it('mode "platform": the user token is used to READ but never to publish', async () => {
    env.google.publishCredentialMode = 'platform';
    const user = await createUser();
    await connectGoogle(user);

    const id = await submitOk(user);
    const job = await waitFor(async () => {
      const j = await UrlJob.findById(id);
      return j && j.publishAttempts >= 1 && j.nextPublishAt ? j : null;
    }, 'first failed attempt, scheduled for retry');

    assert.equal(google.publishCalls.length, 0);
    assert.ok(google.inspectCalls.length > 0);
    assert.ok(google.inspectCalls.every((c) => c.token === 'user-token'));
    assert.ok(job.nextPublishAt);
  });

  it('a token without the Indexing scope can never publish', async () => {
    const user = await createUser();
    await connectGoogle(user, { scopes: [WEBMASTERS_READONLY] });

    const id = await submitOk(user);
    await waitFor(async () => ((await UrlJob.findById(id))?.publishAttempts ?? 0) >= 1, 'first failed attempt');
    assert.equal(google.publishCalls.length, 0);
  });

  it('expired user token is refreshed once and the new token is used and persisted', async () => {
    const user = await createUser();
    await connectGoogle(user, { expiresAt: past(HOUR) });

    const id = await submitOk(user);
    await waitForStatus(id, JobStatus.WAITING_CRAWL);

    assert.equal(google.refreshCalls, 1);
    assert.equal(google.inspectCalls[0].token, 'refreshed-token');
    assert.equal(google.publishCalls[0].token, 'refreshed-token');
    assert.equal((await GoogleToken.findOne({ userId: user._id }))!.accessToken, 'refreshed-token');
  });

  // ─── Failure handling ───────────────────────────────────────────────

  it('transient failure (503): backs off, does not hurt the account, then succeeds', async () => {
    const user = await createUser();
    const sa = await createServiceAccount();
    google.onPublish = (_c, n) => (n === 1 ? reply.status(503, 'Backend error') : reply.ok());

    const id = await submitOk(user);
    const job = await deferred(id);

    assert.equal(job.publishAttempts, 1);
    const wait = job.nextPublishAt!.getTime() - Date.now();
    assert.ok(wait > 4 * MIN && wait <= 5 * MIN + 2000, `first backoff is ~5 min (was ${wait} ms)`);
    assert.equal((await ServiceAccount.findById(sa._id))!.consecutiveErrors, 0);

    await UrlJob.updateOne({ _id: id }, { nextPublishAt: past() });
    await jobOrchestrator.recoverStuckJobs();
    const done = await waitForStatus(id, JobStatus.WAITING_CRAWL);
    assert.equal(done.publishAttempts, 1);
    assert.equal(google.publishCalls.length, 2);
  });

  it('dropped connection is treated as transient', async () => {
    const user = await createUser();
    await createServiceAccount();
    google.onPublish = () => reply.network();
    const id = await submitOk(user);
    const job = await deferred(id);
    assert.equal(job.publishAttempts, 1);
    assert.equal(job.status, JobStatus.WRAPPER_CREATED);
  });

  it('no credential at all: gives up after MAX_PUBLISH_ATTEMPTS and refunds the credit', async () => {
    env.job.maxPublishAttempts = 2;
    const user = await createUser({ credits: 5 });

    const id = await submitOk(user);
    await deferred(id); // attempt 1
    await UrlJob.updateOne({ _id: id }, { nextPublishAt: past() });
    await jobOrchestrator.recoverStuckJobs();

    const failed = await waitForStatus(id, JobStatus.FAILED);
    assert.ok(failed.creditRefundedAt);
    const u = await User.findById(user._id);
    assert.deepEqual([u!.credits, u!.reservedCredits], [5, 0], 'refunded, never charged');
    const messages = failed.errorLog.map((e) => e.message).join(' | ');
    assert.match(messages, /No Google credential available/);
    assert.match(messages, /Gave up after 2/);
  });

  it('Google rejects the request itself (400): fails immediately, refunds, retires the wrapper', async () => {
    const user = await createUser();
    await createServiceAccount();
    google.onPublish = (c) => (c.type === 'URL_UPDATED' ? reply.status(400, 'Invalid URL') : reply.ok());

    const id = await submitOk(user);
    const failed = await waitForStatus(id, JobStatus.FAILED);

    assert.equal(failed.publishAttempts, 0);
    assert.deepEqual(
      [(await User.findById(user._id))!.credits, (await User.findById(user._id))!.reservedCredits],
      [5, 0]
    );
    assert.equal((await WrapperPage.findOne({ jobId: id }))!.status, 'NOINDEX');
    // the removal request is the last step of failure handling, after the status flips to FAILED
    await waitFor(async () => google.publishCalls.some((c) => c.type === 'URL_DELETED'), 'wrapper removal sent to Google');
  });

  // ─── Recovery ───────────────────────────────────────────────────────

  it('recovers a job that sits in QUEUED with no queue entry (Redis flush / crash), without inflating the domain counter', async () => {
    const user = await createUser();
    await createServiceAccount();
    await User.updateOne({ _id: user._id }, { reservedCredits: 1 });
    await DomainActivity.create({ domain: 'customer.com', activeJobCount: 1 });
    const job = await UrlJob.create({
      userId: user._id, originalUrl: URL1, domain: 'customer.com',
      status: JobStatus.QUEUED, queuedAt: past(2 * HOUR), creditReservedAt: past(2 * HOUR),
    });

    assert.equal(await jobOrchestrator.recoverStuckJobs(), 1);
    await waitForStatus(job._id, JobStatus.WAITING_CRAWL);
    assert.equal((await DomainActivity.findOne({ domain: 'customer.com' }))!.activeJobCount, 1);
  });

  it('a failed leftover queue entry no longer blocks re-queuing the job', async () => {
    const user = await createUser();
    await createServiceAccount();
    await User.updateOne({ _id: user._id }, { reservedCredits: 1 });
    const id = new mongoose.Types.ObjectId();

    // A queue entry for a job id the DB doesn't know yet → the worker throws → entry ends up "failed"
    await indexingQueue.add(
      { jobId: id.toString() },
      { jobId: id.toString(), attempts: 1, removeOnComplete: true, removeOnFail: false }
    );
    await waitFor(async () => (await (await indexingQueue.getJob(id.toString()))?.getState()) === 'failed', 'leftover to fail');

    await UrlJob.create({
      _id: id, userId: user._id, originalUrl: URL1, domain: 'customer.com',
      status: JobStatus.QUEUED, queuedAt: past(2 * HOUR), creditReservedAt: past(2 * HOUR),
    });
    assert.equal(await jobOrchestrator.recoverStuckJobs(), 1);
    await waitForStatus(id, JobStatus.WAITING_CRAWL);
  });

  it('does not queue a job twice while it is still live in the queue', async () => {
    const user = await createUser();
    const job = await UrlJob.create({
      userId: user._id, originalUrl: URL1, domain: 'customer.com', status: JobStatus.PENDING,
    });
    env.queue.minDelayMinutes = 60;
    env.queue.maxDelayMinutes = 60;

    assert.equal(await queueService.enqueue(job._id), true);
    assert.equal(await queueService.enqueue(job._id), false, 'second enqueue is a no-op');
    assert.equal((await indexingQueue.getJobCounts()).delayed, 1);
    assert.equal((await DomainActivity.findOne({ domain: 'customer.com' }))!.activeJobCount, 1);
  });

  it('skips a job that finished (or was failed by cleanup) while it waited in the queue', async () => {
    const user = await createUser();
    await createServiceAccount();
    env.queue.minDelayMinutes = 60;
    env.queue.maxDelayMinutes = 60;
    const job = await UrlJob.create({
      userId: user._id, originalUrl: URL1, domain: 'customer.com', status: JobStatus.PENDING,
    });
    await queueService.enqueue(job._id); // sits in the queue for an hour

    // meanwhile the cleanup cron gives up on it
    await UrlJob.updateOne({ _id: job._id }, { status: JobStatus.FAILED });
    await (await indexingQueue.getJob(job._id.toString()))!.promote(); // run it now

    await queueIdle();
    assert.equal(google.publishCalls.length, 0);
    assert.equal(await WrapperPage.countDocuments(), 0);
    assert.equal((await UrlJob.findById(job._id))!.status, JobStatus.FAILED);
  });

  // ─── Retry & cron ───────────────────────────────────────────────────

  it('retry after 24h: old wrapper is retired and removed at Google, a NEW wrapper is published, counters stay correct', async () => {
    const user = await createUser();
    await createServiceAccount();
    const id = await submitOk(user);
    const first = await waitForStatus(id, JobStatus.WAITING_CRAWL);

    await UrlJob.updateOne({ _id: id }, { apiCalledAt: past(25 * HOUR), status: JobStatus.CRAWLED_NOT_INDEXED });
    assert.deepEqual(await retryService.getJobsReadyForRetry(), [id.toString()]);

    await jobOrchestrator.handleRetry(id);
    const second = await waitFor(async () => {
      const j = await UrlJob.findById(id);
      return j?.status === JobStatus.WAITING_CRAWL && j.wrapperUrl !== first.wrapperUrl ? j : null;
    }, 'retried job to be republished');

    assert.equal(second.retryCount, 1);
    assert.equal((await WrapperPage.findOne({ wrapperId: first.wrapperId }))!.status, 'NOINDEX');
    assert.equal((await WrapperPage.findOne({ wrapperId: second.wrapperId }))!.status, 'ACTIVE');
    assert.deepEqual(
      google.publishCalls.map((c) => c.type),
      ['URL_UPDATED', 'URL_DELETED', 'URL_UPDATED']
    );
    assert.equal(google.publishCalls[1].url, first.wrapperUrl);
    assert.equal(google.publishCalls[2].url, second.wrapperUrl);
    assert.equal((await DomainActivity.findOne({ domain: 'customer.com' }))!.activeJobCount, 1);
  });

  it('the status-check cron confirms indexing on its own and skips jobs that are not due', async () => {
    const user = await createUser();
    await createServiceAccount();
    const due = await submitOk(user, URL1);
    await waitForStatus(due, JobStatus.WAITING_CRAWL);

    // a second job that was checked a moment ago: not due yet
    const notDue = await UrlJob.create({
      userId: user._id, originalUrl: URL2, domain: 'customer.com',
      status: JobStatus.WAITING_CRAWL, apiCalledAt: past(HOUR), lastCheckedAt: new Date(),
      creditReservedAt: past(HOUR),
    });

    google.onInspect = () => inspect.indexed;
    env.indexCheck.cron = '*/1 * * * * *'; // every second
    env.indexCheck.firstCheckAfterMinutes = 0;
    startIndexCheckJob();
    try {
      await waitForStatus(due, JobStatus.INDEXED, 15000);
      await sleep(2500); // several more ticks
    } finally {
      stopCron();
    }

    assert.ok(google.inspectCalls.every((c) => c.inspectionUrl !== URL2), 'not-due job was not inspected');
    assert.equal((await UrlJob.findById(notDue._id))!.status, JobStatus.WAITING_CRAWL);
    assert.equal((await User.findById(user._id))!.credits, 4);
  });
});
