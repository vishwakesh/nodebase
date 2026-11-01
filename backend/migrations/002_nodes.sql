CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT '',
  agent_version TEXT NOT NULL DEFAULT 'unknown',
  runtimes_json TEXT NOT NULL DEFAULT '["python","node"]',
  cpu_cores INTEGER NOT NULL DEFAULT 0 CHECK(cpu_cores >= 0),
  cpu_percent REAL,
  memory_total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(memory_total_bytes >= 0),
  memory_used_bytes INTEGER CHECK(memory_used_bytes IS NULL OR memory_used_bytes >= 0),
  storage_total_bytes INTEGER NOT NULL DEFAULT 0 CHECK(storage_total_bytes >= 0),
  storage_used_bytes INTEGER CHECK(storage_used_bytes IS NULL OR storage_used_bytes >= 0),
  workload_count INTEGER CHECK(workload_count IS NULL OR workload_count >= 0),
  status TEXT NOT NULL DEFAULT 'offline' CHECK(status IN ('online','offline','draining','unhealthy','revoked')),
  token_hash TEXT UNIQUE,
  token_suffix TEXT,
  last_heartbeat_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS nodes_status_idx ON nodes(status);
CREATE INDEX IF NOT EXISTS nodes_heartbeat_idx ON nodes(last_heartbeat_at);

CREATE TABLE IF NOT EXISTS node_enrollment_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS node_enrollment_expires_idx ON node_enrollment_tokens(expires_at);
