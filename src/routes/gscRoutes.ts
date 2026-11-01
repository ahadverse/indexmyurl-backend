import { Router } from 'express';
import { gscController } from '../controllers/gscController';
import { authMiddleware } from '../middlewares/authMiddleware';

const router = Router();

// Does the user have Search Console access to this URL's site, and through what
router.get('/access', authMiddleware, (req, res, next) =>
  gscController.getAccess(req, res, next)
);

export default router;
