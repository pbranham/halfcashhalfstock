ALTER TABLE listings ADD COLUMN last_backfilled_at TIMESTAMPTZ NULL;
ALTER TABLE listings ADD COLUMN backfill_attempts INTEGER NOT NULL DEFAULT 0;

-- Index speeds up the periodic 'find listings needing backfill' query.
CREATE INDEX idx_listings_pending_backfill
  ON listings(ended_at)
  WHERE ended_at IS NOT NULL AND last_backfilled_at IS NULL;
