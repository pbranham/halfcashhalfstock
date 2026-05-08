-- Listings: one row per item, current state. Updated on every snapshot poll.
CREATE TABLE IF NOT EXISTS listings (
  item_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  image_url TEXT,
  item_web_url TEXT NOT NULL,
  is_auction BOOLEAN NOT NULL,
  ends_at TIMESTAMPTZ,
  current_price_usd NUMERIC(12, 2),
  current_bid_count INTEGER,
  currency TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bids: append-only individual bid records from the Trading API.
-- UNIQUE on (item_id, bid_time, bidder) makes re-inserts idempotent
-- since the same bid can be re-fetched many times before a new one arrives.
CREATE TABLE IF NOT EXISTS bids (
  id BIGSERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  bidder TEXT NOT NULL,
  bid_time TIMESTAMPTZ NOT NULL,
  bid_amount_usd NUMERIC(12, 2) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, bid_time, bidder)
);

CREATE INDEX IF NOT EXISTS bids_item_time_idx ON bids (item_id, bid_time);
