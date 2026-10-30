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

// ─── Google API quotas reset at midnight Pacific Time, not UTC ────────
const PACIFIC_TZ = 'America/Los_Angeles';

/** Pacific wall-clock offset from UTC (ms) at a given instant: local = utc + offset */
function pacificOffsetMs(date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC_TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string): number =>
    Number(parts.find((p) => p.type === type)!.value);
  const wallAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  );
  return wallAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** The next 00:00 America/Los_Angeles after `from` (DST-aware), as a real instant. */
export function getNextPacificMidnight(from: Date = new Date()): Date {
  const offset = pacificOffsetMs(from);
  const wall = new Date(from.getTime() + offset);
  const nextWallMidnight = Date.UTC(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate() + 1
  );
  let instant = nextWallMidnight - offset;
  // The offset can differ at the target instant if a DST change falls in between
  const offsetAtTarget = pacificOffsetMs(new Date(instant));
  if (offsetAtTarget !== offset) instant = nextWallMidnight - offsetAtTarget;
  return new Date(instant);
}

/** Pacific calendar date (YYYY-MM-DD) — used to bucket daily quota counters. */
export function getPacificDateKey(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PACIFIC_TZ }).format(date);
}
