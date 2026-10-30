import { Router } from 'express';
import { urlController } from '../controllers/urlController';
import { authMiddleware } from '../middlewares/authMiddleware';
import { submitRateLimit, preflightRateLimit } from '../middlewares/rateLimitMiddleware';
import { preflightController, importSitemap } from '../controllers/preflightController';
import { requireQueue } from '../middlewares/queueMiddleware';

const router = Router();

router.use(authMiddleware);

// Scan URLs for indexing blockers before submitting (streams progress as SSE)
router.post('/preflight', preflightRateLimit, (req, res) =>
  preflightController.scan(req, res)
);

// The page URLs listed in a sitemap, to feed into a scan
router.post('/sitemap', preflightRateLimit, (req, res) => importSitemap(req, res));

router.post('/submit', submitRateLimit, requireQueue, (req, res, next) =>
  urlController.submitUrl(req, res, next)
);

// Many URLs in one request (streams progress as SSE)
router.post('/submit/bulk', submitRateLimit, requireQueue, (req, res) =>
  urlController.submitBulk(req, res)
);

// All URLs, one row each, with how many times each was tried
router.get('/all', (req, res, next) =>
  urlController.listUrls(req, res, next)
);

router.get('/jobs', (req, res, next) =>
  urlController.listJobs(req, res, next)
);

router.get('/status/:jobId', (req, res, next) =>
  urlController.getJobStatus(req, res, next)
);

// Manual live refresh — fixes jobs stuck in QUEUED when URL already indexed
router.post('/status/:jobId/refresh', (req, res, next) =>
  urlController.refreshStatus(req, res, next)
);

export default router;
