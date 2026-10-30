import mongoose from 'mongoose';
import { indexingQueue } from '../config/queue';
import { jobOrchestrator } from '../services/jobOrchestratorService';
import { QueueJobPayload } from '../services/queueService';
import { logger } from '../utils/logger';

export function startIndexingWorker(): void {
  indexingQueue.process(async (job) => {
    const { jobId } = job.data as QueueJobPayload;
    logger.info(`Worker: processing job ${jobId}`);
    await jobOrchestrator.processQueuedJob(
      new mongoose.Types.ObjectId(jobId)
    );
  });

  indexingQueue.on('completed', (job) =>
    logger.info(`Queue job completed: ${job.id}`)
  );

  indexingQueue.on('failed', async (job, err) => {
    logger.error(`Queue job failed: ${job.id}`, err);

    // Only act once Bull has used up its retries; the recovery cron re-queues
    // the job later, and publishAttempts caps how often that can happen.
    if (job.attemptsMade < (job.opts.attempts ?? 1)) return;
    try {
      const { jobId } = job.data as QueueJobPayload;
      await jobOrchestrator.handleProcessingError(
        new mongoose.Types.ObjectId(jobId),
        err
      );
    } catch (handlerError) {
      logger.error(`Failed-job handler error for ${job.id}:`, handlerError);
    }
  });

  indexingQueue.on('stalled', (job) =>
    logger.warn(`Queue job stalled: ${job.id}`)
  );

  logger.info('Indexing worker started');
}
