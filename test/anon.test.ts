import { describe, expect, it } from 'vitest';
import { maskBidder } from '../src/anon.js';

describe('maskBidder', () => {
  it('masks a full username to first + asterisks + last', () => {
    expect(maskBidder('boilerpaulie')).toBe('b***e');
    expect(maskBidder('ryan_5050')).toBe('r***0');
  });

  it('passes through already-masked usernames unchanged', () => {
    expect(maskBidder('3***2')).toBe('3***2');
    expect(maskBidder('a***b')).toBe('a***b');
    expect(maskBidder('5****t')).toBe('5****t');
  });

  it('returns "unknown" for empty / null / undefined / "unknown" inputs', () => {
    expect(maskBidder('')).toBe('unknown');
    expect(maskBidder(null)).toBe('unknown');
    expect(maskBidder(undefined)).toBe('unknown');
    expect(maskBidder('unknown')).toBe('unknown');
  });

  it('leaves pathologically short strings (<=2 chars) alone', () => {
    // eBay usernames are 4+ chars in practice but the helper shouldn't blow up.
    expect(maskBidder('a')).toBe('a');
    expect(maskBidder('ab')).toBe('ab');
  });
});
