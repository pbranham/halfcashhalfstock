// The one small ES module the server (src/shared-module.ts) and every browser
// page both read: the input patterns and the time constants live here only.
// No build step, no imports.

// A ticker the server accepts.
export const TICKER_RE = /^[A-Z][A-Z0-9.\-:]{0,19}$/;
// eBay item IDs, including the Browse `v1|<numeric>|0` form.
export const ITEM_ID_RE = /^[A-Za-z0-9|.-]{1,64}$/;

// Durations in milliseconds.
export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
