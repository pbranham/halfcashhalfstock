-- Add interval column to track candle granularity (15m, 1m, etc.)
ALTER TABLE ohlc_data ADD COLUMN interval TEXT NOT NULL DEFAULT '1m';
CREATE INDEX IF NOT EXISTS idx_ohlc_data_interval ON ohlc_data(ticker, interval, period_start DESC);
