import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { jobOrchestrator } from '../services/jobOrchestratorService';
import { indexStatusService } from '../services/indexStatusService';
import { UrlJob, JobStatus } from '../models/UrlJob';
import { env } from '../config/env';
import { preflightService, PreflightIssue } from '../services/preflightService';
import { parseUrlList } from './preflightController';
import { openSse } from '../utils/sse';
import { logger } from '../utils/logger';
import { listUrls, UrlSort } from '../services/urlListService';

/** Most URLs one bulk submission may contain (matches the default daily cap). */
const BULK_SUBMIT_MAX = 50;
/** URLs submitted at the same time within one bulk request. */
const BULK_SUBMIT_CONCURRENCY = 4;

interface PreflightRefusal {
  message: string;
  issues: PreflightIssue[];
}

/**
 * Refuse URLs the pre-flight scan found unindexable. Reuses a scan from the last few
 * minutes when there is one (the dashboard scans first), otherwise scans now.
 */
async function preflightRefusal(url: string): Promise<PreflightRefusal | null> {
  if (!env.preflight.enforceOnSubmit) return null;
  const result = await preflightService.checkForSubmit(url);
  if (result.verdict !== 'blocked') return null;
  const issues = result.issues.filter((i) => i.severity === 'blocker');
  return { message: issues.map((i) => i.message).join(' '), issues };
}

export class UrlController {
  /** POST /api/urls/submit */
  async submitUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { url } = req.body as { url: string };
      if (!url || typeof url !== 'string') {
        res.status(400).json({ success: false, message: 'url is required' });
        return;
      }

      const refusal = await preflightRefusal(url.trim());
      if (refusal) {
        res.status(422).json({ success: false, code: 'PREFLIGHT_BLOCKED', ...refusal });
        return;
      }

      const result = await jobOrchestrator.submitUrl(url.trim(), req.user!._id);

      if (!result.success) {
        res.status(400).json(result);
        return;
      }

      res.status(result.alreadyIndexed ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/urls/submit/bulk  { urls: string[] }
   *
   * Same checks as /submit for every URL, with live progress as a Server-Sent Events stream:
   *   {type:'start',  total, duplicates, urls}
   *   {type:'result', index, done, total, url, success, message, jobId?, alreadyIndexed?, code?, issues?}
   *   {type:'done',   total, submitted, alreadyIndexed, failed, elapsedMs}
   */
  async submitBulk(req: Request, res: Response): Promise<void> {
    const parsed = parseUrlList(req.body, BULK_SUBMIT_MAX);
    if ('error' in parsed) {
      res.status(400).json({ success: false, message: parsed.error });
      return;
    }
    const { urls, duplicates } = parsed;
    const userId = req.user!._id;

    const stream = openSse(res);
    try {
      const startedAt = Date.now();
      const tally = { submitted: 0, alreadyIndexed: 0, failed: 0 };
      let cursor = 0;
      let done = 0;
      stream.send({ type: 'start', total: urls.length, duplicates, urls });

      const worker = async (): Promise<void> => {
        while (!stream.signal.aborted) {
          const index = cursor++;
          if (index >= urls.length) return;
          const url = urls[index];

          let outcome: Record<string, unknown>;
          try {
            const refusal = await preflightRefusal(url);
            if (refusal) {
              outcome = { success: false, code: 'PREFLIGHT_BLOCKED', ...refusal };
            } else {
              outcome = { ...(await jobOrchestrator.submitUrl(url, userId)) };
            }
          } catch (error) {
            logger.error(`Bulk submit failed for ${url}: ${(error as Error).message}`);
            outcome = { success: false, message: 'Internal error while submitting this URL.' };
          }

          if (outcome.success) tally[outcome.alreadyIndexed ? 'alreadyIndexed' : 'submitted']++;
          else tally.failed++;
          done++;
          stream.send({ type: 'result', index, done, total: urls.length, url, ...outcome });
        }
      };
      await Promise.all(Array.from({ length: Math.min(BULK_SUBMIT_CONCURRENCY, urls.length) }, worker));

      stream.send({ type: 'done', total: urls.length, ...tally, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      logger.error(`Bulk submit failed: ${(error as Error).message}`);
      stream.send({ type: 'error', message: 'Bulk submit failed unexpectedly. Check the job list and try again.' });
    } finally {
      stream.end();
    }
  }

  /**
   * GET /api/urls/all?page&limit&search&status&sort=recent|submissions|url
   * Every URL the user has submitted, one row each, with how many times it was tried.
   */
  async listUrls(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const sort = req.query.sort as UrlSort | undefined;
      const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 200) : '';
      // one status, or several separated by commas (e.g. every "pending" status)
      const status =
        typeof req.query.status === 'string'
          ? (req.query.status.split(',').map((s) => s.trim()) as JobStatus[]).filter((s) =>
              Object.values(JobStatus).includes(s)
            )
          : [];

      const result = await listUrls(req.user!._id, {
        page: Math.max(1, parseInt(req.query.page as string) || 1),
        limit: Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 25)),
        search: search || undefined,
        status: status.length ? status : undefined,
        sort: sort && ['recent', 'submissions', 'url'].includes(sort) ? sort : 'recent',
      });
      res.json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/urls/jobs */
  async listJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const userId = req.user!._id;
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, parseInt(req.query.limit as string) || 20);
      const status = req.query.status as JobStatus | undefined;

      const query: Record<string, unknown> = { userId };
      if (status && Object.values(JobStatus).includes(status)) {
        query.status = status;
      }

      const [jobs, total] = await Promise.all([
        UrlJob.find(query)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .select(
            'originalUrl domain status retryCount credentialSource createdAt queuedAt apiCalledAt indexedAt failedAt'
          ),
        UrlJob.countDocuments(query),
      ]);

      res.json({
        success: true,
        jobs,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/urls/status/:jobId */
  async getJobStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;
      if (!mongoose.isValidObjectId(jobId)) {
        res.status(400).json({ success: false, message: 'Invalid job ID' });
        return;
      }

      const job = await UrlJob.findOne({ _id: jobId, userId: req.user!._id }).select(
        '-googleApiResponse'
      );

      if (!job) {
        res.status(404).json({ success: false, message: 'Job not found' });
        return;
      }

      res.json({
        success: true,
        job: {
          id: job._id,
          originalUrl: job.originalUrl,
          domain: job.domain,
          status: job.status,
          retryCount: job.retryCount,
          credentialSource: job.credentialSource,
          createdAt: job.createdAt,
          queuedAt: job.queuedAt,
          apiCalledAt: job.apiCalledAt,
          indexedAt: job.indexedAt,
          failedAt: job.failedAt,
          latestCheck:
            job.indexCheckResults.length > 0
              ? job.indexCheckResults[job.indexCheckResults.length - 1]
              : null,
          errors: job.errorLog.slice(-3),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/urls/status/:jobId/refresh
   * Manual live GSC check — fixes jobs stuck in QUEUED/WAITING when URL is already indexed
   */
  async refreshStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;
      if (!mongoose.isValidObjectId(jobId)) {
        res.status(400).json({ success: false, message: 'Invalid job ID' });
        return;
      }

      const job = await UrlJob.findOne({ _id: jobId, userId: req.user!._id });
      if (!job) {
        res.status(404).json({ success: false, message: 'Job not found' });
        return;
      }

      if (job.status === JobStatus.INDEXED) {
        res.json({ success: true, message: 'Already INDEXED', status: job.status });
        return;
      }

      if (job.status === JobStatus.FAILED) {
        res.json({ success: true, message: 'Job has failed', status: job.status });
        return;
      }

      // Live GSC check
      const check = await indexStatusService.preCheck(job.originalUrl, req.user!._id);

      if (check.status === 'INDEXED') {
        await jobOrchestrator.handleSuccess(new mongoose.Types.ObjectId(jobId));
        res.json({
          success: true,
          message: '✅ URL is now INDEXED! Job updated.',
          status: JobStatus.INDEXED,
          checkedAt: check.checkedAt,
        });
      } else {
        await UrlJob.findByIdAndUpdate(jobId, {
          $push: {
            indexCheckResults: {
              checkedAt: check.checkedAt,
              status: check.status,
              source: check.source,
            },
          },
        });
        res.json({
          success: true,
          message: `GSC status: ${check.status}. Job remains ${job.status}.`,
          status: job.status,
          gscStatus: check.status,
          checkedAt: check.checkedAt,
        });
      }
    } catch (error) {
      next(error);
    }
  }
}

export const urlController = new UrlController();
