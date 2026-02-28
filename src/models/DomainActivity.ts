import mongoose, { Document, Schema } from 'mongoose';

export interface IDomainActivity extends Document {
  domain: string;
  activeJobCount: number;
  totalJobsToday: number;
  lastJobAt: Date | null;
  resetAt: Date;
  isBlocked: boolean;
  blockedReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const DomainActivitySchema = new Schema<IDomainActivity>(
  {
    domain: { type: String, required: true, unique: true, lowercase: true, index: true },
    activeJobCount: { type: Number, default: 0, min: 0 },
    totalJobsToday: { type: Number, default: 0 },
    lastJobAt: { type: Date, default: null },
    resetAt: {
      type: Date,
      default: () => {
        const d = new Date();
        d.setHours(24, 0, 0, 0);
        return d;
      },
    },
    isBlocked: { type: Boolean, default: false },
    blockedReason: { type: String, default: null },
  },
  { timestamps: true }
);

export const DomainActivity = mongoose.model<IDomainActivity>(
  'DomainActivity',
  DomainActivitySchema
);
