-- Cache entries: shared across instances to avoid duplicate API calls.
-- Single-use entries per cache_key (seller listings, stock prices, etc).
-- Entries expire based on expires_at; expired entries can be cleaned up.
CREATE TABLE IF NOT EXISTS cache_entries (
  cache_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cache_entries_expires ON cache_entries(expires_at);
