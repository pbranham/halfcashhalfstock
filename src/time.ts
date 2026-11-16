// Durations and date helpers every module shares.
export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

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
