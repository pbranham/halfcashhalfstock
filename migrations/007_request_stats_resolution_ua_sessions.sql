ALTER TABLE request_stats ADD COLUMN interval TEXT NOT NULL DEFAULT 'hour';

ALTER TABLE request_stats ADD COLUMN bot_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_stats ADD COLUMN mobile_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_stats ADD COLUMN desktop_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE request_stats ADD COLUMN other_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE request_stats DROP CONSTRAINT IF EXISTS request_stats_unique;
ALTER TABLE request_stats ADD CONSTRAINT request_stats_unique UNIQUE (hour, endpoint, status_code, environment, interval);

CREATE INDEX idx_request_stats_interval ON request_stats(interval, hour DESC);

CREATE TABLE session_stats (
  id SERIAL PRIMARY KEY,
  hour TIMESTAMPTZ NOT NULL,
  environment TEXT NOT NULL,
  interval TEXT NOT NULL DEFAULT 'hour',
  session_count INTEGER NOT NULL DEFAULT 0,
  bounce_count INTEGER NOT NULL DEFAULT 0,
  avg_duration_seconds NUMERIC(12, 2) NOT NULL DEFAULT 0,
  avg_requests NUMERIC(10, 2) NOT NULL DEFAULT 0,
  total_duration_seconds NUMERIC(14, 2) NOT NULL DEFAULT 0,
  total_requests INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(hour, environment, interval)
);

CREATE INDEX idx_session_stats_hour ON session_stats(hour DESC);
CREATE INDEX idx_session_stats_environment ON session_stats(environment, hour DESC);
