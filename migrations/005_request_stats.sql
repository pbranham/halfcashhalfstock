CREATE TABLE request_stats (
  id SERIAL PRIMARY KEY,
  hour TIMESTAMPTZ NOT NULL,
  endpoint TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  unique_ips INTEGER NOT NULL DEFAULT 0,
  max_concurrent INTEGER NOT NULL DEFAULT 0,
  avg_concurrent NUMERIC(10, 2) NOT NULL DEFAULT 0,
  min_concurrent INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(hour, endpoint, status_code)
);

CREATE INDEX idx_request_stats_hour ON request_stats(hour DESC);
CREATE INDEX idx_request_stats_endpoint ON request_stats(endpoint, hour DESC);
