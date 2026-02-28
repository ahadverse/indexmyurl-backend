import Bull from 'bull';
import { env } from './env';

const redisOptions = {
  host: env.redis.host,
  port: env.redis.port,
  ...(env.redis.password && { password: env.redis.password }),
};

export const indexingQueue = new Bull('indexing-queue', { redis: redisOptions });
export const statusCheckQueue = new Bull('status-check-queue', { redis: redisOptions });

export const allQueues = [indexingQueue, statusCheckQueue];
