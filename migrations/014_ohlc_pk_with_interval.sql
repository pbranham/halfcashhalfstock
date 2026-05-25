-- Different OHLC intervals at the same period_start are conceptually distinct
-- candles (a 1d candle anchored at trading-day open vs a 15m candle anchored
-- at the same minute are NOT the same row). The original PK was
-- (ticker, period_start), which both prevented coexistence AND made the
-- ON CONFLICT (ticker, period_start, interval) clause in bulkInsertOhlcData
-- reference a non-existent constraint, so the bulk insert path always
-- errored out. Promote the PK to include interval.
ALTER TABLE ohlc_data DROP CONSTRAINT ohlc_data_pkey;
ALTER TABLE ohlc_data ADD PRIMARY KEY (ticker, period_start, interval);
