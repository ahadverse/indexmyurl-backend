import cron from "node-cron";
import mongoose from "mongoose";
import { UrlJob, JobStatus } from "../models/UrlJob";
import { jobOrchestrator } from "../services/jobOrchestratorService";
import { retryService } from "../services/retryService";
import { env } from "../config/env";
import { sleep } from "../utils/helpers";
import { logger } from "../utils/logger";

// ─── Index status check — every 4 hours ──────────────────────────────
export function startIndexCheckJob(): void {
  cron.schedule("0 */2 * * *", async () => {
    logger.info("Cron: index check started");
    try {
      const now = new Date();

      // Active jobs: waiting for crawl
      const activeJobs = await UrlJob.find({
        status: {
          $in: [JobStatus.WAITING_CRAWL, JobStatus.CRAWLED_NOT_INDEXED],
        },
        apiCalledAt: { $lte: new Date(now.getTime() - 2 * 60 * 60 * 1000) },
      }).select("_id");

      // Stale jobs: QUEUED/PENDING > 30 min old (may already be indexed)
      const staleJobs = await UrlJob.find({
        status: { $in: [JobStatus.QUEUED, JobStatus.PENDING] },
        createdAt: { $lte: new Date(now.getTime() - 30 * 60 * 1000) },
      }).select("_id");

      const all = [...activeJobs, ...staleJobs];
      logger.info(
        `Cron: checking ${activeJobs.length} active + ${staleJobs.length} stale jobs`,
      );

      for (const job of all) {
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
    }
  });
  logger.info("Cron: index check scheduled (every 4h)");
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
