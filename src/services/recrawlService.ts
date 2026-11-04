import mongoose from 'mongoose';
import { UrlJob, JobStatus } from '../models/UrlJob';
import { WrapperPage, WrapperStatus } from '../models/WrapperPage';
import { wrapperService } from './wrapperService';
import { googleIndexingService } from './googleIndexingService';
import { serviceAccountPool } from './serviceAccountPool';
import { sitemapService } from './sitemapService';
import { env } from '../config/env';
import { planRecrawl } from '../utils/recrawlPlan';
import { sleep } from '../utils/helpers';
import { logger } from '../utils/logger';

export interface RecrawlRunResult {
  /** Wrappers refreshed and notified again */
  nudged: number;
  /** Extra wrappers created and notified */
  added: number;
  /** Why the run stopped early, if it did */
  stoppedBecause?: 'DISABLED' | 'LOW_QUOTA' | 'QUOTA_EXHAUSTED' | 'RUN_BUDGET';
}

// Only jobs whose first publish went through and that are not indexed yet
const WAITING_STATUSES = [JobStatus.WAITING_CRAWL, JobStatus.CRAWLED_NOT_INDEXED];

/**
 * Asks Google to look again at pages it has not picked up yet.
 *
 * One Indexing API call is a hint, not a promise, so a wrapper Googlebot never fetched is nudged
 * again after a few hours (with refreshed content, so there is something new to fetch), and a job
 * that is still not indexed after about half a day gets a second wrapper at a new URL with a
 * different design. Every extra call spends the daily Indexing API quota, so this:
 *   - uses platform service accounts only (never a customer's own Google token),
 *   - stops when less than RECRAWL_QUOTA_RESERVE publishes are left, so first publishes keep priority,
 *   - spends at most RECRAWL_MAX_PER_RUN calls per run and spaces them out,
 *   - never touches the job's status, apiCalledAt or error log (those drive checks, retries, refunds).
 */
export class RecrawlService {
  async run(now: number = Date.now()): Promise<RecrawlRunResult> {
    const result: RecrawlRunResult = { nudged: 0, added: 0 };
    const cfg = env.recrawl;
    if (!cfg.enabled) return { ...result, stoppedBecause: 'DISABLED' };

    const jobs = await UrlJob.find({
      status: { $in: WAITING_STATUSES },
      apiCalledAt: { $ne: null },
    })
      .select('_id')
      .sort({ apiCalledAt: 1 }) // longest-waiting first
      .limit(500);

    const touched: string[] = [];
    let spent = 0;

    for (const job of jobs) {
      if (spent >= cfg.maxPerRun) {
        result.stoppedBecause = 'RUN_BUDGET';
        break;
      }

      const jobId = new mongoose.Types.ObjectId(job._id.toString());
      const wrappers = await WrapperPage.find({
        jobId,
        status: WrapperStatus.ACTIVE,
        expiresAt: { $gt: new Date(now) },
      }).select('wrapperId wrapperUrl createdAt crawledAt notifyCount lastNotifiedAt');

      const action = planRecrawl(wrappers, cfg, now);
      if (action.type === 'NONE') continue;

      // Quota check right before spending it (first publishes keep priority)
      if ((await serviceAccountPool.remainingQuota()) <= cfg.quotaReserve) {
        result.stoppedBecause = 'LOW_QUOTA';
        break;
      }

      let target: { wrapperId: string; wrapperUrl: string } | null = null;
      if (action.type === 'NUDGE') {
        const refreshed = await wrapperService.refreshWrapper(action.wrapperId);
        if (refreshed) target = { wrapperId: refreshed.wrapperId, wrapperUrl: refreshed.wrapperUrl };
      } else {
        target = await wrapperService.createAdditionalWrapper(jobId);
      }
      if (!target) continue;

      spent++;
      const outcome = await googleIndexingService.notifyUrl(jobId, target.wrapperUrl, 'URL_UPDATED', {
        track: false,
        sources: ['SERVICE_ACCOUNT'],
      });

      if (outcome.outcome === 'SUCCESS') {
        await wrapperService.markNotified(target.wrapperId);
        await UrlJob.findByIdAndUpdate(jobId, {
          $inc: { recrawlCount: 1 },
          $set: { lastRecrawlAt: new Date() },
        });
        touched.push(target.wrapperUrl);
        if (action.type === 'NUDGE') result.nudged++;
        else result.added++;
        logger.info(
          `Recrawl: ${action.type === 'NUDGE' ? 'nudged' : 'added wrapper for'} job ${jobId} → ${target.wrapperUrl}`
        );
      } else if (outcome.outcome === 'QUOTA_EXHAUSTED') {
        // An extra wrapper Google was never told about is dropped rather than left half-created
        if (action.type === 'ADD_WRAPPER') await wrapperService.discardWrapper(target.wrapperId);
        result.stoppedBecause = 'QUOTA_EXHAUSTED';
        break;
      } else {
        if (action.type === 'ADD_WRAPPER') await wrapperService.discardWrapper(target.wrapperId);
        logger.warn(`Recrawl: notify failed for job ${jobId}: ${outcome.message ?? outcome.outcome}`);
      }

      await sleep(500 + Math.floor(Math.random() * 1500)); // no burst of calls
    }

    if (touched.length > 0) {
      // New/refreshed wrappers go into the sitemap and RSS feed, and out to IndexNow (if enabled)
      await sitemapService.sendSecondaryCrawlSignals(touched);
    }
    if (result.nudged + result.added > 0 || result.stoppedBecause) {
      logger.info(
        `Recrawl run: ${result.nudged} nudged, ${result.added} wrapper(s) added${result.stoppedBecause ? ` (stopped: ${result.stoppedBecause})` : ''}`
      );
    }
    return result;
  }
}

export const recrawlService = new RecrawlService();
