import { Router } from 'express';
import { authController } from '../controllers/authController';
import { authMiddleware } from '../middlewares/authMiddleware';
import { authRateLimit } from '../middlewares/rateLimitMiddleware';

const router = Router();

// ─── Public ───────────────────────────────────────────────────────
router.post('/register', authRateLimit, (req, res, next) =>
  authController.register(req, res, next)
);

router.post('/login', authRateLimit, (req, res, next) =>
  authController.login(req, res, next)
);

// ─── Protected ────────────────────────────────────────────────────
router.get('/me', authMiddleware, (req, res, next) =>
  authController.getProfile(req, res, next)
);

router.put('/profile', authMiddleware, (req, res, next) =>
  authController.updateProfile(req, res, next)
);

router.put('/change-password', authMiddleware, (req, res, next) =>
  authController.changePassword(req, res, next)
);

router.post('/regenerate-key', authMiddleware, (req, res, next) =>
  authController.regenerateApiKey(req, res, next)
);

export default router;
