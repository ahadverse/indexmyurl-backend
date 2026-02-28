import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';

export function generateWrapperId(): string {
  return uuidv4().replace(/-/g, '').substring(0, 20);
}

export function generateApiKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function generateRandomDelayMs(minMinutes: number, maxMinutes: number): number {
  const min = minMinutes * 60 * 1000;
  const max = maxMinutes * 60 * 1000;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
}

export function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function normalizeSiteUrl(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getNextMidnight(): Date {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d;
}
