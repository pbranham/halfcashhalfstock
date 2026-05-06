import { describe, it, expect } from 'vitest';
import { splitHalfCashHalfStock, sumSplits } from '../src/math.js';

describe('splitHalfCashHalfStock', () => {
  it('splits an even bid 50/50', () => {
    expect(splitHalfCashHalfStock(100, 50)).toEqual({ cashUsd: 50, stockUsd: 50, shares: 1 });
  });

  it('handles fractional bids and prices', () => {
    const r = splitHalfCashHalfStock(57.92, 7.5);
    expect(r.cashUsd).toBeCloseTo(28.96, 6);
    expect(r.stockUsd).toBeCloseTo(28.96, 6);
    expect(r.shares).toBeCloseTo(28.96 / 7.5, 8);
  });

  it('returns zeros at zero bid', () => {
    expect(splitHalfCashHalfStock(0, 10)).toEqual({ cashUsd: 0, stockUsd: 0, shares: 0 });
  });

  it('rejects negative bids', () => {
    expect(() => splitHalfCashHalfStock(-1, 10)).toThrow(RangeError);
  });

  it('rejects non-finite bids', () => {
    expect(() => splitHalfCashHalfStock(Number.NaN, 10)).toThrow(RangeError);
    expect(() => splitHalfCashHalfStock(Number.POSITIVE_INFINITY, 10)).toThrow(RangeError);
  });

  it('rejects non-positive share prices', () => {
    expect(() => splitHalfCashHalfStock(100, 0)).toThrow(RangeError);
    expect(() => splitHalfCashHalfStock(100, -5)).toThrow(RangeError);
  });
});

describe('sumSplits', () => {
  it('returns zeroes for empty input', () => {
    expect(sumSplits([])).toEqual({ cashUsd: 0, stockUsd: 0, shares: 0 });
  });

  it('sums each component independently', () => {
    const a = splitHalfCashHalfStock(100, 50);
    const b = splitHalfCashHalfStock(40, 50);
    expect(sumSplits([a, b])).toEqual({ cashUsd: 70, stockUsd: 70, shares: 1.4 });
  });
});
