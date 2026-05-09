ALTER TABLE request_stats ADD COLUMN environment TEXT NOT NULL DEFAULT 'production';

ALTER TABLE request_stats DROP CONSTRAINT IF EXISTS request_stats_hour_endpoint_status_code_key;

ALTER TABLE request_stats ADD CONSTRAINT request_stats_unique UNIQUE (hour, endpoint, status_code, environment);

CREATE INDEX idx_request_stats_environment ON request_stats(environment, hour DESC);
