import mongoose, { Document, Schema } from 'mongoose';

export interface IServiceAccount extends Document {
  _id: mongoose.Types.ObjectId;
  email: string;
  privateKey: string;
  projectId: string;

  // Quota (Google allows 200 Indexing API calls/day per service account)
  dailyQuotaUsed: number;
  dailyQuotaLimit: number;
  quotaResetAt: Date;

  // Health tracking
  isActive: boolean;
  consecutiveErrors: number;
  lastUsedAt: Date | null;
  lastErrorAt: Date | null;
  lastErrorMessage: string | null;

  createdAt: Date;
  updatedAt: Date;
}

const ServiceAccountSchema = new Schema<IServiceAccount>(
  {
    email: { type: String, required: true, unique: true, trim: true },
    privateKey: { type: String, required: true },
    projectId: { type: String, required: true },

    dailyQuotaUsed: { type: Number, default: 0 },
    dailyQuotaLimit: { type: Number, default: 180 }, // 200 max — keep 20 buffer
    quotaResetAt: {
      type: Date,
      default: () => {
        const d = new Date();
        d.setUTCHours(24, 0, 0, 0);
        return d;
      },
    },

    isActive: { type: Boolean, default: true },
    consecutiveErrors: { type: Number, default: 0 },
    lastUsedAt: { type: Date, default: null },
    lastErrorAt: { type: Date, default: null },
    lastErrorMessage: { type: String, default: null },
  },
  { timestamps: true }
);

ServiceAccountSchema.index({ isActive: 1, dailyQuotaUsed: 1 });

export const ServiceAccount = mongoose.model<IServiceAccount>(
  'ServiceAccount',
  ServiceAccountSchema
);
