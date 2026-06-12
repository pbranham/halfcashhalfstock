-- When a viewbids HTML paste is imported for an item (reconcileItemBids),
-- stamp the listing. This is the only durable signal distinguishing a
-- complete, human-verified bid timeline (the paste is eBay's own bid
-- history page) from the per-bidder max bids the Trading API trickles in —
-- both land in the same `bids` table. The item page uses it to label the
-- chart's data source honestly.
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS bids_imported_at TIMESTAMPTZ;
