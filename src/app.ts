import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import mongoose from 'mongoose';
import { env } from './config/env';
import { isRedisReady } from './config/queue';
import { apiRateLimit } from './middlewares/rateLimitMiddleware';
import { errorMiddleware, notFoundMiddleware } from './middlewares/errorMiddleware';

import authRoutes from './routes/authRoutes';
import oauthRoutes from './routes/oauthRoutes';
import urlRoutes from './routes/urlRoutes';
import adminRoutes from './routes/adminRoutes';
import publicRoutes from './routes/publicRoutes';

const app = express();

// Behind a reverse proxy the client IP arrives in X-Forwarded-For. Without this,
// every user looks like the proxy's IP and shares a single rate-limit bucket.
if (env.server.trustProxy > 0) app.set('trust proxy', env.server.trustProxy);

// ─── Security & parsing ───────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: env.server.frontendUrl, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Rate limiting ────────────────────────────────────────────────
app.use('/api', apiRateLimit);

// ─── Health check ─────────────────────────────────────────────────
// 503 when a dependency is down, so a load balancer / monitor sees it too
app.get('/health', (_req, res) => {
  const mongo = mongoose.connection.readyState === 1;
  const redis = isRedisReady();
  res.status(mongo && redis ? 200 : 503).json({
    status: mongo && redis ? 'ok' : 'degraded',
    mongo: mongo ? 'up' : 'down',
    redis: redis ? 'up' : 'down',
    timestamp: new Date().toISOString(),
    env: env.server.nodeEnv,
  });
});

// ─── API Routes ───────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/oauth', oauthRoutes);
app.use('/api/urls', urlRoutes);
app.use('/api/admin', adminRoutes);

// ─── Public routes (wrapper pages, sitemap, robots) ──────────────
app.use('/', publicRoutes);

// ─── Error handling ───────────────────────────────────────────────
app.use(notFoundMiddleware);
app.use(errorMiddleware);

export default app;
