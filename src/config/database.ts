import mongoose from 'mongoose';
import { env } from './env';
import { logger } from '../utils/logger';

export async function connectDatabase(): Promise<void> {
  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('error', (err) => logger.error('MongoDB error:', err));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));

  try {
    await mongoose.connect(env.mongodb.uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
  } catch (err) {
    if ((err as { syscall?: string }).syscall === 'querySrv') {
      logger.error(
        'MongoDB: the DNS lookup for the mongodb+srv:// address failed (Node cannot reach a DNS server). ' +
          'Set DNS_SERVERS=1.1.1.1,8.8.8.8 in .env, or use the non-SRV mongodb:// connection string from Atlas.'
      );
    }
    throw err;
  }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  logger.info('MongoDB disconnected gracefully');
}
