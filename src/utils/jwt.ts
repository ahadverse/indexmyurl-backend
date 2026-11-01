import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface JwtPayload {
  userId: string;
  email: string;
}

// ─── OAuth `state` ────────────────────────────────────────────────────
// The state goes to Google and comes back to our public callback, so it must be
// tamper-proof: an unsigned "connect:<userId>" would let anyone attach their Google
// account to someone else's profile. It is signed with a key derived from the JWT
// secret rather than the secret itself, so a state token (which shows up in URLs)
// can never be accepted as a login token by verifyToken.
export type OAuthState = { flow: 'login' } | { flow: 'connect'; userId: string };

const OAUTH_STATE_TTL_SECONDS = 10 * 60;

function oauthStateKey(): Buffer {
  return crypto
    .createHmac('sha256', env.security.jwtSecret)
    .update('indexmenow:oauth-state:v1')
    .digest();
}

export function signOAuthState(
  state: OAuthState,
  ttlSeconds: number = OAUTH_STATE_TTL_SECONDS
): string {
  return jwt.sign({ ...state }, oauthStateKey(), { expiresIn: ttlSeconds });
}

/** The state if it is genuine and unexpired, otherwise null. */
export function verifyOAuthState(token: string): OAuthState | null {
  try {
    const payload = jwt.verify(token, oauthStateKey()) as { flow?: unknown; userId?: unknown };
    if (payload.flow === 'login') return { flow: 'login' };
    if (payload.flow === 'connect' && typeof payload.userId === 'string' && payload.userId) {
      return { flow: 'connect', userId: payload.userId };
    }
    return null;
  } catch {
    return null;
  }
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.security.jwtSecret, {
    expiresIn: '30d',
  });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.security.jwtSecret) as JwtPayload;
}
