import { ApiUsage } from '../models/ApiUsage';
import { getNextPacificMidnight, getPacificDateKey } from '../utils/helpers';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Atomic daily budgets shared across all app instances (stored in MongoDB). */
export class ApiUsageService {
  private keyFor(bucket: string): string {
    return `${bucket}:${getPacificDateKey()}`;
  }

  // Keep the row a day past its reset so a late read still finds it
  private expiry(): Date {
    return new Date(getNextPacificMidnight().getTime() + DAY_MS);
  }

  /** Take one unit from today's budget. Returns false when the budget is spent. */
  async tryConsume(bucket: string, limit: number): Promise<boolean> {
    try {
      const doc = await ApiUsage.findOneAndUpdate(
        { key: this.keyFor(bucket), count: { $lt: limit } },
        { $inc: { count: 1 }, $setOnInsert: { expiresAt: this.expiry() } },
        { upsert: true, new: true }
      );
      return !!doc;
    } catch (error) {
      // Row exists but count >= limit, so the upsert tried to insert a duplicate key
      if ((error as { code?: number }).code === 11000) return false;
      throw error;
    }
  }

  /** Google told us we're out of quota — stop spending the rest of today's budget. */
  async markExhausted(bucket: string, limit: number): Promise<void> {
    await ApiUsage.updateOne(
      { key: this.keyFor(bucket) },
      { $max: { count: limit }, $setOnInsert: { expiresAt: this.expiry() } },
      { upsert: true }
    );
  }

  async isExhausted(bucket: string, limit: number): Promise<boolean> {
    const doc = await ApiUsage.findOne({ key: this.keyFor(bucket) }).select('count');
    return !!doc && doc.count >= limit;
  }
}

export const apiUsageService = new ApiUsageService();
