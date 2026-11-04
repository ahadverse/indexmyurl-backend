import mongoose from 'mongoose';
import { UrlJob, JobStatus } from '../models/UrlJob';
import { wrapperService } from './wrapperService';
import { googleIndexingService } from './googleIndexingService';
import { queueService } from './queueService';
import { env } from '../config/env';
import { isRetryWaitOver, retryDueCutoff } from '../utils/schedule';
import { logger } from '../utils/logger';

export class RetryService {
  async isEligibleForRetry(jobId: mongoose.Types.ObjectId): Promise<boolean> {
    const job = await UrlJob.findById(jobId);
    if (!job) return false;

    if ([JobStatus.INDEXED, JobStatus.FAILED].includes(job.status)) return false;
    if (job.retryCount >= env.job.maxRetryCount) return false;
    if (this.isExpired(job.createdAt)) return false;

    if (job.lastRetryAt) {
      const minWaitMs = env.job.retryMinWaitHours * 60 * 60 * 1000;
      if (!isRetryWaitOver({ now: Date.now(), since: job.lastRetryAt, minWaitMs })) return false;
    }

    return true;
  }

  /**
   * Retry: deactivate old wrapper → re-enqueue (queue handles delay + domain limit)
   */
  async retry(jobId: mongoose.Types.ObjectId): Promise<boolean> {
    const job = await UrlJob.findById(jobId);
    if (!job) return false;

    logger.info(`Retrying job ${jobId} (attempt #${job.retryCount + 1})`);

    try {
      // Deactivate the old wrappers (the first one and any extras) and tell Google to drop them
      const retired = await wrapperService.deactivateJobWrappers(
        jobId,
        `retry_${job.retryCount + 1}`
      );
      for (const wrapperUrl of new Set([...retired, ...(job.wrapperUrl ? [job.wrapperUrl] : [])])) {
        await googleIndexingService.removeUrl(wrapperUrl);
      }

      // Reset job state
      const nextRetryAt = new Date(
        Date.now() + env.job.retryMinWaitHours * 60 * 60 * 1000
      );

      await UrlJob.findByIdAndUpdate(jobId, {
        status: JobStatus.RETRYING,
        retryCount: job.retryCount + 1,
        lastRetryAt: new Date(),
        nextRetryAt,
        wrapperId: null,
        wrapperUrl: null,
        wrapperActiveAt: null,
        wrapperDeactivatedAt: null,
        apiCalledAt: null,
        googleApiResponse: null,
        credentialSource: null,
        googleTokenId: null,
        serviceAccountId: null,
      });

      // Re-enqueue — worker will create new wrapper + new API call
      await queueService.enqueue(jobId);

      logger.info(`Job ${jobId} re-queued for retry #${job.retryCount + 1}`);
      return true;
    } catch (error) {
      logger.error(`Retry scheduling failed for job ${jobId}:`, error);
      await UrlJob.findByIdAndUpdate(jobId, {
        $push: {
          errorLog: {
            timestamp: new Date(),
            message: `Retry error: ${String(error)}`,
            step: 'RETRY',
          },
        },
      });
      return false;
    }
  }

  async getJobsReadyForRetry(): Promise<string[]> {
    const minWaitMs = env.job.retryMinWaitHours * 60 * 60 * 1000;
    const cutoff = retryDueCutoff(Date.now(), minWaitMs);

    const jobs = await UrlJob.find({
      status: { $in: [JobStatus.WAITING_CRAWL, JobStatus.CRAWLED_NOT_INDEXED] },
      retryCount: { $lt: env.job.maxRetryCount },
      $or: [
        { lastRetryAt: null, apiCalledAt: { $lte: cutoff } },
        { lastRetryAt: { $lte: cutoff } },
      ],
    }).select('_id');

    return jobs.map((j) => j._id.toString());
  }

  private isExpired(createdAt: Date): boolean {
    return (
      Date.now() - createdAt.getTime() >
      env.job.failAfterDays * 24 * 60 * 60 * 1000
    );
  }
}

export const retryService = new RetryService();
