import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface JwtPayload {
  userId: string;
  email: string;
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.security.jwtSecret, {
    expiresIn: '30d',
  });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.security.jwtSecret) as JwtPayload;
}
