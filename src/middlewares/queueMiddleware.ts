import { Request, Response, NextFunction } from 'express';
import { isRedisReady } from '../config/queue';

/**
 * Refuse work that needs the job queue while Redis is unreachable. Without this a submission
 * would reserve a credit, create a job and then wait forever for the queue.
 */
export function requireQueue(_req: Request, res: Response, next: NextFunction): void {
  if (isRedisReady()) {
    next();
    return;
  }
  res.status(503).json({
    success: false,
    code: 'QUEUE_UNAVAILABLE',
    message: 'The indexing queue is temporarily unavailable. Nothing was charged; please try again in a moment.',
  });
}
