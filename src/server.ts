import 'dotenv/config';
import app from './app';
import { env } from './config/env';
import { connectDatabase, disconnectDatabase } from './config/database';
import { allQueues } from './config/queue';
import { serviceAccountPool } from './services/serviceAccountPool';
import { startIndexingWorker } from './jobs/indexingWorker';
import { startIndexCheckJob, startRetryJob, startCleanupJob } from './jobs/cronJobs';
import { logger } from './utils/logger';

async function bootstrap(): Promise<void> {
  // 1. Connect DB
  await connectDatabase();

  // 2. Seed platform service account from .env (if configured)
  await serviceAccountPool.seedFromEnv();

  // 3. Start Bull queue worker
  startIndexingWorker();

  // 4. Start cron jobs
  startIndexCheckJob();
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
