CREATE TABLE seen_ips (
  ip_hash TEXT NOT NULL,
  hour TIMESTAMPTZ NOT NULL,
  environment TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (ip_hash, hour, environment)
);

CREATE INDEX idx_seen_ips_hour ON seen_ips(hour DESC);
CREATE INDEX idx_seen_ips_environment ON seen_ips(environment, hour DESC);
