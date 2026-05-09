-- OHLC (Open, High, Low, Close) data for stock price history.
-- Stores minute-by-minute candles to enable sparklines and trend analysis.
-- One row per ticker per minute; old data can be pruned (e.g., keep 7-10 market days).
CREATE TABLE IF NOT EXISTS ohlc_data (
  ticker TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  open NUMERIC(10, 2),
  high NUMERIC(10, 2),
  low NUMERIC(10, 2),
  close NUMERIC(10, 2),
  source TEXT,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticker, period_start)
);

CREATE INDEX IF NOT EXISTS idx_ohlc_data_ticker_start ON ohlc_data(ticker, period_start DESC);
