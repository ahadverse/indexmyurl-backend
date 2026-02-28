import { Router } from 'express';
import { oauthController } from '../controllers/oauthController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// ─── Public (no auth needed) ──────────────────────────────────────
// Step 1a: Get Google login/register URL
router.get('/google/login-url', (req, res, next) =>
  oauthController.getLoginUrl(req, res, next)
);

// Step 2: Google redirects here after consent (handles both flows)
router.get('/google/callback', (req, res, next) =>
  oauthController.handleCallback(req, res, next)
);

// ─── Protected (auth required) ────────────────────────────────────
// Step 1b: Get Google connect URL (for linking GSC to existing account)
router.get('/google/connect-url', authMiddleware, (req, res, next) =>
  oauthController.getConnectUrl(req, res, next)
);

// List connected Google accounts
router.get('/google/accounts', authMiddleware, (req, res, next) =>
  oauthController.listAccounts(req, res, next)
);

// Re-sync GSC properties
router.post('/google/sync', authMiddleware, (req, res, next) =>
  oauthController.syncProperties(req, res, next)
);

// Disconnect a Google account
router.delete('/google/:googleAccountId', authMiddleware, (req, res, next) =>
  oauthController.disconnect(req, res, next)
);

export default router;
