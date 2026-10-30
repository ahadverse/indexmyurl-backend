import mongoose, { Document, Schema } from 'mongoose';

/** Daily counter for an API budget shared by the whole platform (e.g. OAuth publishes). */
export interface IApiUsage extends Document {
  key: string;        // "<bucket>:<Pacific date>"
  count: number;
  expiresAt: Date;    // TTL — old days clean themselves up
}

const ApiUsageSchema = new Schema<IApiUsage>({
  key: { type: String, required: true, unique: true },
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
});

ApiUsageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ApiUsage = mongoose.model<IApiUsage>('ApiUsage', ApiUsageSchema);
