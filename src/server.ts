import 'dotenv/config';
import app from './app';
import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/database';
import { allQueues, waitForRedis } from './config/queue';
import { serviceAccountPool } from './services/serviceAccountPool';
import { startIndexingWorker } from './jobs/indexingWorker';
import {
  startIndexCheckJob,
  startRecoveryJob,
  startRetryJob,
  startCleanupJob,
} from './jobs/cronJobs';
import { logger } from './utils/logger';

async function bootstrap(): Promise<void> {
  // 0. Redis is not optional: the job queue, the worker and the retry/recovery crons all
  //    depend on it. Without it every submission would wait forever, so refuse to start.
  if (!(await waitForRedis())) {
    logger.error(
      `Redis is not reachable at ${env.redis.host}:${env.redis.port}. ` +
        'IndexMeNow cannot run without it: start Redis (or fix REDIS_HOST / REDIS_PORT / REDIS_PASSWORD in .env) and start the backend again.'
    );
    process.exit(1);
  }
  logger.info(`Redis connected (${env.redis.host}:${env.redis.port})`);

  // 1. Connect DB
  await connectDatabase();

  // 2. Seed platform service account from .env (if configured)
  await serviceAccountPool.seedFromEnv();

  // 3. Start Bull queue worker
  startIndexingWorker();

  // 4. Start cron jobs
  startIndexCheckJob();
  startRecoveryJob();
  startRetryJob();
  startCleanupJob();

  // 5. Start HTTP server
  const server = app.listen(env.server.port, () => {
    logger.info(`🚀 IndexMeNow running on port ${env.server.port} [${env.server.nodeEnv}]`);
    logger.info(`📡 Base URL: ${env.server.baseUrl}`);
    logger.info(`🔑 OAuth redirect: ${env.google.oauth.redirectUri}`);
  });

  // ─── Graceful shutdown ────────────────────────────────────────
  async function shutdown(signal: string): Promise<void> {
    logger.info(`${signal} received — shutting down...`);
    server.close(async () => {
      await Promise.all(allQueues.map((q) => q.close()));
      await disconnectDatabase();
      logger.info('Shutdown complete');
      process.exit(0);
    });
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
