import mongoose from "mongoose";
import { UrlJob, JobStatus } from "../models/UrlJob";
import { urlValidationService } from "./urlValidationService";
import { creditService } from "./creditService";
import { queueService } from "./queueService";
import { wrapperService } from "./wrapperService";
import { googleIndexingService, PublishResult } from "./googleIndexingService";
import { sitemapService } from "./sitemapService";
import { indexStatusService } from "./indexStatusService";
import { retryService } from "./retryService";
import { env } from "../config/env";
import {
  extractDomain,
  generateRandomDelayMs,
  getNextPacificMidnight,
} from "../utils/helpers";
import { publishRetryDelayMs } from "../utils/schedule";
import { logger } from "../utils/logger";

export interface SubmitResult {
  success: boolean;
  jobId?: string;
  status?: JobStatus;
  alreadyIndexed?: boolean;
  message: string;
}

export class JobOrchestratorService {
  // ─────────────────────────────────────────────────────────────────
  // STEP 0+1: Validate, pre-check, reserve credit, create job
  // ─────────────────────────────────────────────────────────────────
  async submitUrl(
    url: string,
    userId: mongoose.Types.ObjectId,
  ): Promise<SubmitResult> {
    // Validate
    const validation = await urlValidationService.validate(url, userId);
    if (!validation.isValid) {
      return { success: false, message: validation.reason! };
    }

    // Pre-check: already indexed? (only act on definitive INDEXED — ignore ERROR)
    const preCheck = await indexStatusService.preCheck(url, userId);
    if (preCheck.status === "INDEXED") {
      const domain = extractDomain(url);
      const job = await UrlJob.create({
        userId,
        originalUrl: url,
        domain,
        status: JobStatus.INDEXED,
        indexedAt: new Date(),
        indexCheckResults: [
          {
            checkedAt: new Date(),
            status: "INDEXED",
            source: "GSC_API_PRECHECK",
          },
        ],
      });

      logger.info(
        `Job ${job._id}: already indexed (pre-check) — no credit charged`,
      );
      return {
        success: true,
        jobId: job._id.toString(),
        status: JobStatus.INDEXED,
        alreadyIndexed: true,
        message: "✅ URL is already indexed in Google. No credit charged.",
      };
    }

    // Daily cap check
    const dailyCap = await creditService.checkDailyCap(userId);
    if (!dailyCap.allowed) {
      return {
        success: false,
        message: `Daily limit reached. ${dailyCap.remaining} submissions remaining.`,
      };
    }

    // Credit check
    if (!(await creditService.hasAvailableCredit(userId))) {
      return { success: false, message: "Insufficient credits." };
    }

    // Reserve credit
    if (!(await creditService.reserveCredit(userId))) {
      return {
        success: false,
        message: "Failed to reserve credit. Try again.",
      };
    }

    // Create job. If this fails the reserved credit must be given back, otherwise
    // it stays reserved forever. A duplicate-key error means another request for the
    // same URL got in first (the unique index is the real guard against the race).
    const domain = extractDomain(url);
    let job;
    try {
      job = await UrlJob.create({
        userId,
        originalUrl: url,
        domain,
        status: JobStatus.PENDING,
        creditReservedAt: new Date(),
      });
    } catch (error) {
      await creditService.refundCredit(userId);
      if ((error as { code?: number }).code === 11000) {
        return { success: false, message: "URL already submitted. It is already being processed." };
      }
      throw error;
    }

    // Enqueue with smart delay
    await queueService.enqueue(job._id);

    logger.info(`Job ${job._id} created and queued | url: ${url}`);
    return {
      success: true,
      jobId: job._id.toString(),
      status: JobStatus.QUEUED,
      message: "URL submitted. Indexing started.",
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // STEPS 3–5: Process from Bull queue
  // ─────────────────────────────────────────────────────────────────
  async processQueuedJob(jobId: mongoose.Types.ObjectId): Promise<void> {
    const job = await UrlJob.findById(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    // The job may have finished (or been failed by cleanup) while it sat in the queue
    if ([JobStatus.INDEXED, JobStatus.FAILED].includes(job.status)) {
      logger.info(`Job ${jobId} already ${job.status} — skipping`);
      return;
    }

    // Double-check: indexed yet? (only short-circuit on INDEXED — ignore ERROR/NOT_FOUND)
    const check = await indexStatusService.preCheck(
      job.originalUrl,
      job.userId,
    );
    if (check.status === "INDEXED") {
      logger.info(`Job ${jobId} already indexed during queue processing`);
      await this.handleSuccess(jobId);
      return;
    }

    // Always create wrapper regardless of GSC check result
    const { wrapperUrl } = await wrapperService.createWrapper(jobId);
    logger.info(`Wrapper created for job ${jobId}: ${wrapperUrl}`);

    // Call Google Indexing API
    const result = await googleIndexingService.notifyUrl(jobId, wrapperUrl);
    if (result.outcome !== "SUCCESS") {
      await this.handlePublishFailure(jobId, result);
      return;
    }

    // Secondary crawl signals
    await sitemapService.sendSecondaryCrawlSignals([wrapperUrl]);

    logger.info(`Job ${jobId} processed — waiting for Googlebot`);
  }

  // ─────────────────────────────────────────────────────────────────
  // Indexing API call did not succeed: defer it (the recovery cron
  // re-queues it when due) or give up and refund.
  // ─────────────────────────────────────────────────────────────────
  private async handlePublishFailure(
    jobId: mongoose.Types.ObjectId,
    result: PublishResult,
  ): Promise<void> {
    if (result.outcome === "QUOTA_EXHAUSTED") {
      // Not the job's fault, so it doesn't use up an attempt. Resume after the
      // Pacific-midnight reset, spread out so every waiting job doesn't hit at once.
      const resumeAt = new Date(
        getNextPacificMidnight().getTime() + generateRandomDelayMs(1, 30),
      );
      await UrlJob.findByIdAndUpdate(jobId, { nextPublishAt: resumeAt });
      logger.warn(
        `Job ${jobId}: Indexing API quota spent — resuming at ${resumeAt.toISOString()}`,
      );
      return;
    }

    if (result.outcome === "PERMANENT") {
      await this.failPublish(jobId, result.message ?? "Google rejected the request");
      return;
    }

    // RETRYABLE
    const job = await UrlJob.findByIdAndUpdate(
      jobId,
      { $inc: { publishAttempts: 1 } },
      { new: true },
    );
    if (!job) return;

    if (job.publishAttempts >= env.job.maxPublishAttempts) {
      await this.failPublish(
        jobId,
        `Gave up after ${job.publishAttempts} failed Indexing API attempts. ${result.message ?? ""}`.trim(),
      );
      return;
    }

    const retryAt = new Date(Date.now() + publishRetryDelayMs(job.publishAttempts));
    await UrlJob.findByIdAndUpdate(jobId, { nextPublishAt: retryAt });
    logger.warn(
      `Job ${jobId}: Indexing API attempt ${job.publishAttempts}/${env.job.maxPublishAttempts} failed — retrying at ${retryAt.toISOString()}`,
    );
  }

  private async failPublish(
    jobId: mongoose.Types.ObjectId,
    message: string,
  ): Promise<void> {
    await UrlJob.findByIdAndUpdate(jobId, {
      $push: { errorLog: { timestamp: new Date(), message, step: "PUBLISH" } },
    });
    await this.handleFailure(jobId);
  }

  // ─────────────────────────────────────────────────────────────────
  // The queue processor threw (DB error, etc.) and Bull used up its
  // attempts. Count it like a failed publish so a job can't loop forever.
  // ─────────────────────────────────────────────────────────────────
  async handleProcessingError(
    jobId: mongoose.Types.ObjectId,
    error: Error,
  ): Promise<void> {
    await this.handlePublishFailure(jobId, {
      outcome: "RETRYABLE",
      message: `Worker error: ${error.message}`,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Safety net: re-queue jobs that are due after a deferral, or that
  // sit in QUEUED/WRAPPER_CREATED with no live queue entry (Redis
  // flush, crash, exhausted worker attempts).
  // ─────────────────────────────────────────────────────────────────
  async recoverStuckJobs(): Promise<number> {
    const now = Date.now();
    // Longest legitimate wait in the queue: max delay + busy-domain extra (20) + margin
    const stuckBefore = new Date(
      now - (env.queue.maxDelayMinutes + 30) * 60 * 1000,
    );

    const candidates = await UrlJob.find({
      $or: [
        {
          status: { $in: [JobStatus.QUEUED, JobStatus.WRAPPER_CREATED] },
          $or: [
            { nextPublishAt: { $lte: new Date(now) } },
            { nextPublishAt: null, queuedAt: { $lte: stuckBefore } },
          ],
        },
        // Created but never queued (e.g. Redis was down at submit time)
        { status: JobStatus.PENDING, queuedAt: null, createdAt: { $lte: stuckBefore } },
      ],
    })
      .select("_id")
      .limit(200);

    let requeued = 0;
    for (const candidate of candidates) {
      try {
        // enqueue() leaves a job alone if it is still live in the queue
        const queued = await queueService.enqueue(
          new mongoose.Types.ObjectId(candidate._id.toString()),
        );
        if (queued) requeued++;
      } catch (err) {
        logger.error(`Recovery re-queue failed for job ${candidate._id}:`, err);
      }
    }
    return requeued;
  }

  // ─────────────────────────────────────────────────────────────────
  // STEP 7–8: Check status
  // ─────────────────────────────────────────────────────────────────
  async checkAndHandleStatus(jobId: mongoose.Types.ObjectId): Promise<void> {
    const result = await indexStatusService.checkJobStatus(jobId);
    if (result.status === "INDEXED") {
      await this.handleSuccess(jobId);
    } else if (result.status === "CRAWLED_NOT_INDEXED") {
      await UrlJob.findByIdAndUpdate(jobId, {
        status: JobStatus.CRAWLED_NOT_INDEXED,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // STEP 8: Success
  // ─────────────────────────────────────────────────────────────────
  async handleSuccess(jobId: mongoose.Types.ObjectId): Promise<void> {
    const job = await UrlJob.findById(jobId);
    if (!job || job.status === JobStatus.INDEXED) return;

    await UrlJob.findByIdAndUpdate(jobId, {
      status: JobStatus.INDEXED,
      indexedAt: new Date(),
      creditDeductedAt: new Date(),
    });

    if (job.creditReservedAt && !job.creditDeductedAt) {
      await creditService.deductCredit(job.userId);
    }

    if (job.wrapperId) {
      await wrapperService.deactivateWrapper(job.wrapperId, "success");
    }

    await queueService.decrementDomainCount(job.domain);
    logger.info(`Job ${jobId} SUCCESS ✅`);
  }

  // ─────────────────────────────────────────────────────────────────
  // STEP 9: Retry
  // ─────────────────────────────────────────────────────────────────
  async handleRetry(jobId: mongoose.Types.ObjectId): Promise<void> {
    const eligible = await retryService.isEligibleForRetry(jobId);
    if (!eligible) {
      await this.handleFailure(jobId);
      return;
    }
    await retryService.retry(jobId);
  }

  // ─────────────────────────────────────────────────────────────────
  // STEP 10: Failure
  // ─────────────────────────────────────────────────────────────────
  async handleFailure(jobId: mongoose.Types.ObjectId): Promise<void> {
    const job = await UrlJob.findById(jobId);
    if (!job || job.status === JobStatus.FAILED) return;

    await UrlJob.findByIdAndUpdate(jobId, {
      status: JobStatus.FAILED,
      failedAt: new Date(),
      creditRefundedAt: new Date(),
    });

    if (job.creditReservedAt && !job.creditDeductedAt) {
      await creditService.refundCredit(job.userId);
    }

    if (job.wrapperId) {
      await wrapperService.deactivateWrapper(job.wrapperId, "failed");
      if (job.wrapperUrl) {
        await googleIndexingService.removeUrl(job.wrapperUrl);
      }
    }

    await queueService.decrementDomainCount(job.domain);
    logger.info(`Job ${jobId} FAILED ❌ — credit refunded`);
  }
}

export const jobOrchestrator = new JobOrchestratorService();
