import mongoose, { Document, Schema } from 'mongoose';

export enum WrapperStatus {
  ACTIVE = 'ACTIVE',
  NOINDEX = 'NOINDEX',
  DELETED = 'DELETED',
}

export interface IWrapperPage extends Document {
  _id: mongoose.Types.ObjectId;
  wrapperId: string;
  jobId: mongoose.Types.ObjectId;
  originalUrl: string;
  wrapperUrl: string;
  htmlContent: string;
  status: WrapperStatus;
  expiresAt: Date;
  crawledAt: Date | null;
  deactivatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const WrapperPageSchema = new Schema<IWrapperPage>(
  {
    wrapperId: { type: String, required: true, unique: true, index: true },
    jobId: { type: Schema.Types.ObjectId, ref: 'UrlJob', required: true },
    originalUrl: { type: String, required: true },
    wrapperUrl: { type: String, required: true },
    htmlContent: { type: String, required: true },
    status: {
      type: String,
      enum: Object.values(WrapperStatus),
      default: WrapperStatus.ACTIVE,
      index: true,
    },
    expiresAt: { type: Date, required: true, index: true },
    crawledAt: { type: Date, default: null },
    deactivatedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

export const WrapperPage = mongoose.model<IWrapperPage>('WrapperPage', WrapperPageSchema);
