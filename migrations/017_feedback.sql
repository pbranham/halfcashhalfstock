-- Buyer feedback captured from the Trading API GetFeedback call, mapped to
-- the listings we track. eBay's profile pages only link feedback to items
-- for a limited window (~90 days, same flavor as viewbids), so the hourly
-- sweep preserves the record permanently here.
--
-- item_id stores the CANONICAL listings.item_id (v1|<n>|0), mapped from the
-- numeric ItemID GetFeedback returns, so joins against listings are direct.
-- commenting_user stores the raw eBay username; it is masked at the API
-- boundary before any public response (same policy as bidders).
CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  item_id TEXT NOT NULL,
  commenting_user TEXT NOT NULL,
  comment_type TEXT NOT NULL,
  comment_text TEXT,
  comment_time TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, commenting_user, comment_time)
);

CREATE INDEX IF NOT EXISTS feedback_item_idx ON feedback (item_id);
