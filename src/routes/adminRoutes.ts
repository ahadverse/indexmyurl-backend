import { Router } from 'express';
import { adminController } from '../controllers/adminController';
import { adminMiddleware } from '../middlewares/authMiddleware';

const router = Router();

router.use(adminMiddleware);

// Service Accounts
router.get('/service-accounts', (req, res, next) =>
  adminController.listServiceAccounts(req, res, next)
);
router.post('/service-accounts', (req, res, next) =>
  adminController.addServiceAccount(req, res, next)
);
router.patch('/service-accounts/:id/toggle', (req, res, next) =>
  adminController.toggleServiceAccount(req, res, next)
);
router.post('/service-accounts/:id/reset-quota', (req, res, next) =>
  adminController.resetQuota(req, res, next)
);

// Users
router.get('/users', (req, res, next) => adminController.listUsers(req, res, next));
router.post('/users/:userId/credits', (req, res, next) =>
  adminController.addCredits(req, res, next)
);

export default router;
