-- Per-item details fetched from eBay's single-item Browse endpoint
-- (/buy/browse/v1/item/{item_id}): the seller's full gallery (beyond the
-- one thumbnail surfaced by item_summary/search) and the HTML description.
-- Stored 1:1 with listings; nullable until the background detail-enrichment
-- pass fills them in.
--
-- additional_images is the gallery URLs ONLY (not including the primary
-- image_url column already on the row), so callers can render [primary,
-- ...additional] without dedup. Stored as JSONB instead of TEXT[] so empty
-- arrays and future shape extensions are cheap.
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS additional_images JSONB,
  ADD COLUMN IF NOT EXISTS description_html TEXT,
  ADD COLUMN IF NOT EXISTS details_fetched_at TIMESTAMPTZ;
