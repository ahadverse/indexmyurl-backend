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
  /** Returns false when the job was already live in the queue and left alone. */
  async enqueue(jobId: mongoose.Types.ObjectId): Promise<boolean> {
    const job = await UrlJob.findById(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);

    // Bull ignores add() when a job with the same id still exists. A finished or
    // failed leftover would silently swallow a re-queue, so clear it first; a job
    // that is genuinely still queued or running is left alone.
    const existing = await indexingQueue.getJob(jobId.toString());
    if (existing) {
      const state = await existing.getState();
      if (['waiting', 'delayed', 'active', 'paused'].includes(state)) {
        logger.debug(`Job ${jobId} already in queue (${state}) — not re-queuing`);
        return false;
      }
      await existing.remove();
    }

    const domainActivity = await DomainActivity.findOne({ domain: job.domain });
    // On a re-queue this job is already part of the domain's active count
    const currentCount =
      (domainActivity?.activeJobCount ?? 0) - (job.queuedAt ? 1 : 0);

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
      nextPublishAt: null,
    });

    // Count the domain's active jobs once per job. A re-queue (retry or
    // recovery) of an already-counted job must not inflate the counter, since
    // it is only decremented once, when the job finishes.
    if (!job.queuedAt) {
      await DomainActivity.findOneAndUpdate(
        { domain: job.domain },
        { $inc: { activeJobCount: 1, totalJobsToday: 1 }, $set: { lastJobAt: new Date() } },
        { upsert: true }
      );
    }

    logger.info(
      `Job ${jobId} queued | domain: ${job.domain} | delay: ${Math.round(delayMs / 60000)}min`
    );
    return true;
  }

  async decrementDomainCount(domain: string): Promise<void> {
    await DomainActivity.findOneAndUpdate(
      { domain },
      { $inc: { activeJobCount: -1 } }
    );
  }
}

export const queueService = new QueueService();
