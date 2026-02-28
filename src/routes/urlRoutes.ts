import { Router } from 'express';
import { urlController } from '../controllers/urlController';
import { authMiddleware } from '../middlewares/authMiddleware';
import { submitRateLimit } from '../middlewares/rateLimitMiddleware';

const router = Router();

router.use(authMiddleware);

router.post('/submit', submitRateLimit, (req, res, next) =>
  urlController.submitUrl(req, res, next)
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
