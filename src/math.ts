export interface HalfSplit {
  cashUsd: number;
  stockUsd: number;
  shares: number;
}

export function splitHalfCashHalfStock(bidUsd: number, sharePrice: number): HalfSplit {
  if (!Number.isFinite(bidUsd) || bidUsd < 0) {
    throw new RangeError('bidUsd must be a non-negative finite number');
  }
  if (!Number.isFinite(sharePrice) || sharePrice <= 0) {
    throw new RangeError('sharePrice must be a positive finite number');
  }
  const cashUsd = bidUsd / 2;
  const stockUsd = bidUsd / 2;
  const shares = stockUsd / sharePrice;
  return { cashUsd, stockUsd, shares };
}

export function sumSplits(splits: readonly HalfSplit[]): HalfSplit {
  return splits.reduce<HalfSplit>(
    (acc, s) => ({
      cashUsd: acc.cashUsd + s.cashUsd,
      stockUsd: acc.stockUsd + s.stockUsd,
      shares: acc.shares + s.shares,
    }),
    { cashUsd: 0, stockUsd: 0, shares: 0 },
  );
}
