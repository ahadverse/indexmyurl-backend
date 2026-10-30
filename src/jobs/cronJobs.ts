import cron from "node-cron";
import mongoose from "mongoose";
import { UrlJob, JobStatus } from "../models/UrlJob";
import { jobOrchestrator } from "../services/jobOrchestratorService";
import { retryService } from "../services/retryService";
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

// ─── Retry eligible jobs — every 6 hours ─────────────────────────────
export function startRetryJob(): void {
  cron.schedule("0 */6 * * *", async () => {
    logger.info("Cron: retry job started");
    try {
      const jobIds = await retryService.getJobsReadyForRetry();
      logger.info(`Cron: ${jobIds.length} jobs eligible for retry`);

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
    }
  });
  logger.info("Cron: retry job scheduled (every 6h)");
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
