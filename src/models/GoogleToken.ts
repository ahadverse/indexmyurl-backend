import mongoose, { Document, Schema } from 'mongoose';

export interface IGoogleToken extends Document {
  _id: mongoose.Types.ObjectId;
  userId: mongoose.Types.ObjectId;

  // Google account identity
  googleAccountId: string;   // Google's sub (unique per Google account)
  googleEmail: string;

  // Tokens
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiresAt: Date;

  // Scopes the user granted
  scopes: string[];

  // GSC properties this Google account owns/manages
  gscProperties: string[];
  lastPropertiesSyncAt: Date | null;

  // Health
  isActive: boolean;
  lastUsedAt: Date | null;
  refreshFailCount: number;   // if > 3, ask user to reconnect

  createdAt: Date;
  updatedAt: Date;
}

const GoogleTokenSchema = new Schema<IGoogleToken>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    googleAccountId: { type: String, required: true },
    googleEmail: { type: String, required: true, lowercase: true },

    accessToken: { type: String, required: true },
    refreshToken: { type: String, required: true },
    tokenType: { type: String, default: 'Bearer' },
    expiresAt: { type: Date, required: true },

    scopes: [{ type: String }],
    gscProperties: [{ type: String }],
    lastPropertiesSyncAt: { type: Date, default: null },

    isActive: { type: Boolean, default: true },
    lastUsedAt: { type: Date, default: null },
    refreshFailCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One user can connect multiple Google accounts — but same Google account only once per user
GoogleTokenSchema.index({ userId: 1, googleAccountId: 1 }, { unique: true });

export const GoogleToken = mongoose.model<IGoogleToken>('GoogleToken', GoogleTokenSchema);
