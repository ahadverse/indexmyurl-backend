import mongoose from "mongoose";
import { UrlJob, JobStatus } from "../models/UrlJob";
import { urlValidationService } from "./urlValidationService";
import { creditService } from "./creditService";
import { queueService } from "./queueService";
import { wrapperService } from "./wrapperService";
import { googleIndexingService } from "./googleIndexingService";
import { sitemapService } from "./sitemapService";
import { indexStatusService } from "./indexStatusService";
import { retryService } from "./retryService";
import { extractDomain } from "../utils/helpers";
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

    // Create job
    const domain = extractDomain(url);
    const job = await UrlJob.create({
      userId,
      originalUrl: url,
      domain,
      status: JobStatus.PENDING,
      creditReservedAt: new Date(),
    });

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
    const ok = await googleIndexingService.notifyUrl(jobId, wrapperUrl);
    if (!ok) {
      // Log error but don't throw — job stays WRAPPER_CREATED, cron will retry
      logger.warn(
        `Google Indexing API call failed for job ${jobId} — will retry`,
      );
      return;
    }

    // Secondary crawl signals
    await sitemapService.sendSecondaryCrawlSignals();

    logger.info(`Job ${jobId} processed — waiting for Googlebot`);
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
