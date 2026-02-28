import mongoose from 'mongoose';
import { UrlJob, JobStatus } from '../models/UrlJob';
import { DomainActivity } from '../models/DomainActivity';
import { indexingQueue } from '../config/queue';
import { generateRandomDelayMs } from '../utils/helpers';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export interface QueueJobPayload {
  jobId: string;
}

export class QueueService {
  async enqueue(jobId: mongoose.Types.ObjectId): Promise<void> {
    const job = await UrlJob.findById(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    const domainActivity = await DomainActivity.findOne({ domain: job.domain });
    const currentCount = domainActivity?.activeJobCount ?? 0;

    // Base delay + extra if domain is busy
    let delayMs = generateRandomDelayMs(
      env.queue.minDelayMinutes,
      env.queue.maxDelayMinutes
    );

    if (currentCount >= env.queue.domainConcurrentLimit) {
      delayMs += generateRandomDelayMs(10, 20); // extra 10–20 min
      logger.warn(`Domain ${job.domain} is busy (${currentCount} active), adding extra delay`);
    }

    await indexingQueue.add(
      { jobId: jobId.toString() } as QueueJobPayload,
      {
        delay: delayMs,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
        jobId: jobId.toString(),
      }
    );

    await UrlJob.findByIdAndUpdate(jobId, {
      status: JobStatus.QUEUED,
      queuedAt: new Date(),
    });

    await DomainActivity.findOneAndUpdate(
      { domain: job.domain },
      { $inc: { activeJobCount: 1, totalJobsToday: 1 }, $set: { lastJobAt: new Date() } },
      { upsert: true }
    );

    logger.info(
      `Job ${jobId} queued | domain: ${job.domain} | delay: ${Math.round(delayMs / 60000)}min`
    );
  }

  async decrementDomainCount(domain: string): Promise<void> {
    await DomainActivity.findOneAndUpdate(
      { domain },
      { $inc: { activeJobCount: -1 } }
    );
  }
}

export const queueService = new QueueService();
