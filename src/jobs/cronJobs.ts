import cron from "node-cron";
import mongoose from "mongoose";
import { UrlJob, JobStatus } from "../models/UrlJob";
import { jobOrchestrator } from "../services/jobOrchestratorService";
import { retryService } from "../services/retryService";
import { recrawlService } from "../services/recrawlService";
import { env } from "../config/env";
import { sleep } from "../utils/helpers";
import { isStatusCheckDue } from "../utils/schedule";
import { logger } from "../utils/logger";

// Jobs the Indexing API has been called for — Googlebot is (or should be) crawling
const PUBLISHED_STATUSES = [
  JobStatus.WAITING_CRAWL,
  JobStatus.CRAWLED_NOT_INDEXED,
];
// Jobs not published yet (queued, or deferred by quota/backoff) — might already be indexed
const UNPUBLISHED_STATUSES = [
  JobStatus.PENDING,
  JobStatus.QUEUED,
  JobStatus.WRAPPER_CREATED,
];
const UNPUBLISHED_FIRST_CHECK_MS = 30 * 60 * 1000;

// ─── Index status check — adaptive per job (see utils/schedule.ts) ───
export function startIndexCheckJob(): void {
  let running = false;

  cron.schedule(env.indexCheck.cron, async () => {
    if (running) {
      logger.warn("Cron: previous index check still running — skipping this tick");
      return;
    }
    running = true;

    try {
      const now = Date.now();
      const publishedFirstCheckMs = env.indexCheck.firstCheckAfterMinutes * 60 * 1000;

      const candidates = await UrlJob.find({
        status: { $in: [...PUBLISHED_STATUSES, ...UNPUBLISHED_STATUSES] },
      }).select("_id status createdAt apiCalledAt lastCheckedAt");

      const due = candidates.filter((job) => {
        const published = PUBLISHED_STATUSES.includes(job.status);
        return isStatusCheckDue({
          now,
          startedAt: (published && job.apiCalledAt) || job.createdAt,
          lastCheckedAt: job.lastCheckedAt,
          firstCheckAfterMs: published
            ? publishedFirstCheckMs
            : UNPUBLISHED_FIRST_CHECK_MS,
        });
      });

      if (due.length > 0) {
        logger.info(
          `Cron: index check — ${due.length} due of ${candidates.length} open jobs`,
        );
      }

      for (const job of due) {
        try {
          await jobOrchestrator.checkAndHandleStatus(
            new mongoose.Types.ObjectId(job._id.toString()),
          );
          await sleep(600); // ~100 GSC API calls/minute max
        } catch (err) {
          logger.error(`Index check failed for job ${job._id}:`, err);
        }
      }
    } catch (error) {
      logger.error("Cron index check failed:", error);
    } finally {
      running = false;
    }
  });
  logger.info(`Cron: index check scheduled (${env.indexCheck.cron})`);
}

// ─── Recover stuck / deferred jobs — every 10 minutes ────────────────
export function startRecoveryJob(): void {
  let running = false;

  cron.schedule("*/10 * * * *", async () => {
    if (running) return;
    running = true;

    try {
      const requeued = await jobOrchestrator.recoverStuckJobs();
      if (requeued > 0) {
        logger.info(`Cron: recovery re-queued ${requeued} job(s)`);
      }
    } catch (error) {
      logger.error("Cron recovery failed:", error);
    } finally {
      running = false;
    }
  });
  logger.info("Cron: recovery scheduled (every 10 min)");
}

// ─── Re-crawl nudges — pages Googlebot has not fetched yet ───────────
export function startRecrawlJob(): void {
  if (!env.recrawl.enabled) {
    logger.info("Cron: recrawl disabled (RECRAWL_ENABLED=false)");
    return;
  }
  let running = false;

  cron.schedule(env.recrawl.cron, async () => {
    if (running) return;
    running = true;

    try {
      await recrawlService.run();
    } catch (error) {
      logger.error("Cron recrawl failed:", error);
    } finally {
      running = false;
    }
  });
  const r = env.recrawl;
  logger.info(
    `Cron: recrawl scheduled (${r.cron}; nudge after ${r.nudgeAfterHours}h x${r.maxNudgesPerWrapper}, ` +
      `extra wrapper after ${r.extraWrapperAfterHours}h, max ${r.maxWrappersPerJob} wrapper(s)/job, ` +
      `${r.maxPerRun} calls/run, quota reserve ${r.quotaReserve})`,
  );
}

// ─── Retry eligible jobs — RETRY_CRON (default every 30 minutes) ─────
export function startRetryJob(): void {
  let running = false;

  cron.schedule(env.job.retryCron, async () => {
    if (running) return;
    running = true;

    try {
      const jobIds = await retryService.getJobsReadyForRetry();
      if (jobIds.length > 0) {
        logger.info(`Cron: ${jobIds.length} jobs eligible for retry`);
      }

      for (const jobId of jobIds) {
        try {
          await jobOrchestrator.handleRetry(new mongoose.Types.ObjectId(jobId));
          await sleep(1000);
        } catch (err) {
          logger.error(`Retry failed for job ${jobId}:`, err);
        }
      }
    } catch (error) {
      logger.error("Cron retry job failed:", error);
    } finally {
      running = false;
    }
  });
  logger.info(
    `Cron: retry job scheduled (${env.job.retryCron}; wait ${env.job.retryMinWaitHours}h, max ${env.job.maxRetryCount} retries)`,
  );
}

// ─── Cleanup expired jobs — daily at midnight ─────────────────────────
export function startCleanupJob(): void {
  cron.schedule("0 0 * * *", async () => {
    logger.info("Cron: cleanup started");
    try {
      const cutoff = new Date(
        Date.now() - env.job.failAfterDays * 24 * 60 * 60 * 1000,
      );

      const expired = await UrlJob.find({
        status: { $nin: [JobStatus.INDEXED, JobStatus.FAILED] },
        createdAt: { $lte: cutoff },
      }).select("_id");

      logger.info(`Cron: failing ${expired.length} expired jobs`);

      for (const job of expired) {
        try {
          await jobOrchestrator.handleFailure(
            new mongoose.Types.ObjectId(job._id.toString()),
          );
        } catch (err) {
          logger.error(`Cleanup failed for job ${job._id}:`, err);
        }
      }
    } catch (error) {
      logger.error("Cron cleanup failed:", error);
    }
  });
  logger.info("Cron: cleanup scheduled (daily midnight)");
}
