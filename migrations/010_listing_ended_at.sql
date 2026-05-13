ALTER TABLE listings ADD COLUMN ended_at TIMESTAMPTZ NULL;

CREATE INDEX idx_listings_ended_at ON listings(ended_at DESC) WHERE ended_at IS NOT NULL;
CREATE INDEX idx_listings_active ON listings(item_id) WHERE ended_at IS NULL;
