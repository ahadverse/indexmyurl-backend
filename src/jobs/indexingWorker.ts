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

  indexingQueue.on('failed', (job, err) =>
    logger.error(`Queue job failed: ${job.id}`, err)
  );

  indexingQueue.on('stalled', (job) =>
    logger.warn(`Queue job stalled: ${job.id}`)
  );

  logger.info('Indexing worker started');
}
