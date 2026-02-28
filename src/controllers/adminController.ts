import { Request, Response, NextFunction } from 'express';
import { ServiceAccount } from '../models/ServiceAccount';
import { serviceAccountPool } from '../services/serviceAccountPool';
import { User } from '../models/User';
import { creditService } from '../services/creditService';
import mongoose from 'mongoose';

export class AdminController {
  /** GET /api/admin/service-accounts */
  async listServiceAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const summary = await serviceAccountPool.getQuotaSummary();
      res.json({ success: true, ...summary });
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/admin/service-accounts */
  async addServiceAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, privateKey, projectId, dailyQuotaLimit } = req.body as {
        email: string;
        privateKey: string;
        projectId: string;
        dailyQuotaLimit?: number;
      };

      if (!email || !privateKey || !projectId) {
        res.status(400).json({
          success: false,
          message: 'email, privateKey, projectId required',
        });
        return;
      }

      const account = await serviceAccountPool.addAccount({
        email,
        privateKey,
        projectId,
        dailyQuotaLimit,
      });

      res.status(201).json({
        success: true,
        message: 'Service account added to pool',
        account: {
          id: account._id,
          email: account.email,
          dailyQuotaLimit: account.dailyQuotaLimit,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /** PATCH /api/admin/service-accounts/:id/toggle */
  async toggleServiceAccount(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const account = await ServiceAccount.findById(req.params.id);
      if (!account) {
        res.status(404).json({ success: false, message: 'Not found' });
        return;
      }

      account.isActive = !account.isActive;
      if (account.isActive) account.consecutiveErrors = 0;
      await account.save();

      res.json({
        success: true,
        message: `Service account ${account.isActive ? 'activated' : 'deactivated'}`,
        isActive: account.isActive,
      });
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/admin/service-accounts/:id/reset-quota */
  async resetQuota(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tomorrow = new Date();
      tomorrow.setUTCHours(24, 0, 0, 0);

      await ServiceAccount.findByIdAndUpdate(req.params.id, {
        dailyQuotaUsed: 0,
        consecutiveErrors: 0,
        isActive: true,
        quotaResetAt: tomorrow,
      });

      res.json({ success: true, message: 'Quota reset' });
    } catch (error) {
      next(error);
    }
  }

  /** POST /api/admin/users/:userId/credits */
  async addCredits(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { amount } = req.body as { amount: number };
      const { userId } = req.params;

      if (!mongoose.isValidObjectId(userId) || !amount || amount <= 0) {
        res.status(400).json({ success: false, message: 'Valid userId and amount required' });
        return;
      }

      await creditService.addCredits(new mongoose.Types.ObjectId(userId), amount);
      const user = await User.findById(userId).select('email credits');

      res.json({ success: true, message: `${amount} credits added`, user });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/admin/users */
  async listUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const page = Math.max(1, parseInt(req.query.page as string) || 1);
      const limit = Math.min(100, parseInt(req.query.limit as string) || 20);

      const [users, total] = await Promise.all([
        User.find()
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .select('email credits reservedCredits dailySubmissions isActive createdAt'),
        User.countDocuments(),
      ]);

      res.json({
        success: true,
        users,
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const adminController = new AdminController();
