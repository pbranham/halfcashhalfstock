-- Track which eBay seller each listing belongs to so the dashboard can show
-- listings from more than one seller (e.g. ryan_5050 + boilerpaulie).
-- Existing rows are all Ryan Cohen's, so we default + then drop the default
-- so future inserts must specify a seller.
ALTER TABLE listings ADD COLUMN seller_id TEXT NOT NULL DEFAULT 'ryan_5050';
ALTER TABLE listings ALTER COLUMN seller_id DROP DEFAULT;

CREATE INDEX idx_listings_seller_id ON listings(seller_id);
