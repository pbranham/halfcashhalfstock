import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// public/constants.js is read by the browser as-is and by the server here, so
// the patterns and durations have one home. Loaded by path (it is not part of
// the TypeScript build), so its shape is stated once, below.
const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'constants.js');

export const { TICKER_RE, ITEM_ID_RE, MINUTE_MS, HOUR_MS, DAY_MS } = (await import(
  pathToFileURL(file).href
)) as {
  TICKER_RE: RegExp;
  ITEM_ID_RE: RegExp;
  MINUTE_MS: number;
  HOUR_MS: number;
  DAY_MS: number;
};
