// Durations and date helpers every module shares.
import { DAY_MS, HOUR_MS, MINUTE_MS } from './shared-module.js';

export { MINUTE_MS, HOUR_MS, DAY_MS };

// The moment `ms` milliseconds before `from` (default: now).
export function msAgo(ms: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - ms);
}

// The moment `days` days before `from` (default: now).
export function daysAgo(days: number, from: Date = new Date()): Date {
  return msAgo(days * DAY_MS, from);
}

// A nullable timestamp as ISO text (null/undefined become null).
export function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}
