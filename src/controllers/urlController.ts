import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import { jobOrchestrator } from '../services/jobOrchestratorService';
import { indexStatusService } from '../services/indexStatusService';
import { UrlJob, JobStatus } from '../models/UrlJob';

export class UrlController {
  /** POST /api/urls/submit */
  async submitUrl(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { url } = req.body as { url: string };
      if (!url || typeof url !== 'string') {
        res.status(400).json({ success: false, message: 'url is required' });
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
