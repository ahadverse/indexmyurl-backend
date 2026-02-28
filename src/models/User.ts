import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
  _id: mongoose.Types.ObjectId;

  // Basic info
  firstName: string;
  lastName: string;
  email: string;
  password: string | null;       // null if Google-only account
  profilePicture: string | null;

  // Auth method
  authProvider: 'local' | 'google' | 'both';
  googleId: string | null;       // Google sub (if logged in via Google)

  // API access
  apiKey: string;

  // Credits
  credits: number;
  reservedCredits: number;

  // Daily cap
  dailySubmissions: number;
  dailySubmissionsResetAt: Date;

  // Status
  isActive: boolean;
  isEmailVerified: boolean;
  lastLoginAt: Date | null;

  createdAt: Date;
  updatedAt: Date;

  // Methods
  comparePassword(plain: string): Promise<boolean>;
  getFullName(): string;
}

const UserSchema = new Schema<IUser>(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 50 },
    lastName:  { type: String, required: true, trim: true, maxlength: 50 },
    email:     { type: String, required: true, unique: true, lowercase: true, trim: true },
    password:  { type: String, default: null },          // hashed
    profilePicture: { type: String, default: null },

    authProvider: {
      type: String,
      enum: ['local', 'google', 'both'],
      default: 'local',
    },
    googleId: { type: String, default: null, sparse: true },

    apiKey: { type: String, required: true, unique: true, index: true },

    credits:         { type: Number, default: 0, min: 0 },
    reservedCredits: { type: Number, default: 0, min: 0 },

    dailySubmissions: { type: Number, default: 0 },
    dailySubmissionsResetAt: {
      type: Date,
      default: () => {
        const d = new Date();
        d.setHours(24, 0, 0, 0);
        return d;
      },
    },

    isActive:        { type: Boolean, default: true },
    isEmailVerified: { type: Boolean, default: false },
    lastLoginAt:     { type: Date, default: null },
  },
  { timestamps: true }
);

// Hash password before save
UserSchema.pre('save', async function (next) {
  if (!this.isModified('password') || !this.password) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password
UserSchema.methods.comparePassword = async function (plain: string): Promise<boolean> {
  if (!this.password) return false;
  return bcrypt.compare(plain, this.password);
};

// Full name helper
UserSchema.methods.getFullName = function (): string {
  return `${this.firstName} ${this.lastName}`;
};

export const User = mongoose.model<IUser>('User', UserSchema);
