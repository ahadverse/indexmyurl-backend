import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import { env } from './config/env';
import { apiRateLimit } from './middlewares/rateLimitMiddleware';
import { errorMiddleware, notFoundMiddleware } from './middlewares/errorMiddleware';

import authRoutes from './routes/authRoutes';
import oauthRoutes from './routes/oauthRoutes';
import urlRoutes from './routes/urlRoutes';
import adminRoutes from './routes/adminRoutes';
import publicRoutes from './routes/publicRoutes';

const app = express();

// ─── Security & parsing ───────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: env.server.frontendUrl, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Rate limiting ────────────────────────────────────────────────
app.use('/api', apiRateLimit);

// ─── Health check ─────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), env: env.server.nodeEnv });
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
