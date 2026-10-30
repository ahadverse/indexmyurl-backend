import Bull from 'bull';
import { env } from './env';
import { logger } from '../utils/logger';

const redisOptions = {
  host: env.redis.host,
  port: env.redis.port,
  ...(env.redis.password && { password: env.redis.password }),
};

const queueOptions = { redis: redisOptions, prefix: env.redis.queuePrefix };

export const indexingQueue = new Bull('indexing-queue', queueOptions);
export const statusCheckQueue = new Bull('status-check-queue', queueOptions);

export const allQueues = [indexingQueue, statusCheckQueue];

// Bull reconnects to a lost Redis silently, and every queue command then waits for the
// connection forever. Report it, at most every 30 s per queue, so a missing Redis is obvious.
for (const queue of allQueues) {
  let lastLogged = 0;
  queue.on('error', (err: Error) => {
    if (Date.now() - lastLogged < 30_000) return;
    lastLogged = Date.now();
    logger.error(`Redis ${env.redis.host}:${env.redis.port} (${queue.name}): ${describe(err)}`);
  });
}

/** Is the connection to Redis up right now? */
export function isRedisReady(): boolean {
  return (indexingQueue.client as unknown as { status?: string }).status === 'ready';
}

/**
 * Resolves true once Redis is connected, false if that takes longer than `timeoutMs`.
 * (Bull's own isReady() resolves as soon as the client object exists, even when Redis is
 * down, so the connection status is polled instead.)
 */
export async function waitForRedis(timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!isRedisReady()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/** A readable reason for a Redis connection error (Node reports ECONNREFUSED with an empty message). */
function describe(err: unknown): string {
  const e = err as { message?: string; code?: string; errors?: Array<{ code?: string; message?: string }> };
  return (
    e.message ||
    e.code ||
    e.errors?.map((x) => x.code || x.message).filter(Boolean).join(', ') ||
    'connection failed'
  );
}
