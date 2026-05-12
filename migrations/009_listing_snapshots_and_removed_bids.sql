CREATE TABLE listing_snapshots (
  id SERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  current_price_usd NUMERIC(12, 2) NOT NULL,
  current_bid_count INTEGER NOT NULL,
  currency TEXT NOT NULL,
  is_auction BOOLEAN NOT NULL,
  ends_at TIMESTAMPTZ
);

CREATE INDEX idx_listing_snapshots_item ON listing_snapshots(item_id, observed_at DESC);

ALTER TABLE bids ADD COLUMN removed_at TIMESTAMPTZ NULL;
ALTER TABLE bids ADD COLUMN first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX idx_bids_removed_at ON bids(item_id, removed_at);
