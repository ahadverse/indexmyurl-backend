import mongoose from 'mongoose';
import { User } from '../models/User';
import { env } from '../config/env';
import { getNextMidnight } from '../utils/helpers';
import { logger } from '../utils/logger';

export class CreditService {
  async hasAvailableCredit(userId: mongoose.Types.ObjectId): Promise<boolean> {
    const user = await User.findById(userId).select('credits reservedCredits');
    if (!user) return false;
    return user.credits - user.reservedCredits > 0;
  }

  async checkDailyCap(
    userId: mongoose.Types.ObjectId
  ): Promise<{ allowed: boolean; remaining: number }> {
    const user = await User.findById(userId).select(
      'dailySubmissions dailySubmissionsResetAt'
    );
    if (!user) return { allowed: false, remaining: 0 };

    if (new Date() > user.dailySubmissionsResetAt) {
      await User.findByIdAndUpdate(userId, {
        dailySubmissions: 0,
        dailySubmissionsResetAt: getNextMidnight(),
      });
      return { allowed: true, remaining: env.queue.userDailyCap };
    }

    const remaining = env.queue.userDailyCap - user.dailySubmissions;
    return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
  }

  async reserveCredit(userId: mongoose.Types.ObjectId): Promise<boolean> {
    const result = await User.findOneAndUpdate(
      {
        _id: userId,
        $expr: { $gt: [{ $subtract: ['$credits', '$reservedCredits'] }, 0] },
      },
      { $inc: { reservedCredits: 1, dailySubmissions: 1 } },
      { new: true }
    );

    if (!result) {
      logger.warn(`Credit reservation failed for user ${userId}`);
      return false;
    }
    return true;
  }

  async deductCredit(userId: mongoose.Types.ObjectId): Promise<void> {
    await User.findByIdAndUpdate(userId, {
      $inc: { credits: -1, reservedCredits: -1 },
    });
  }

  async refundCredit(userId: mongoose.Types.ObjectId): Promise<void> {
    await User.findByIdAndUpdate(userId, { $inc: { reservedCredits: -1 } });
  }

  async addCredits(userId: mongoose.Types.ObjectId, amount: number): Promise<void> {
    await User.findByIdAndUpdate(userId, { $inc: { credits: amount } });
  }
}

export const creditService = new CreditService();
