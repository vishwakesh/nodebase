CREATE TABLE IF NOT EXISTS admin (
  id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_token TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, created_at TEXT NOT NULL, user_agent TEXT, ip TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, runtime TEXT NOT NULL CHECK(runtime IN ('python','node')),
  entrypoint TEXT NOT NULL DEFAULT 'main.py', startup_command TEXT NOT NULL DEFAULT '',
  install_deps INTEGER NOT NULL DEFAULT 1, restart_on_failure INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'stopped', container_id TEXT, last_error TEXT,
  last_deployed_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_env (
  bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  key TEXT NOT NULL, encrypted_value TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(bot_id, key)
);
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS folders_parent_idx ON folders(parent_id);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  blob_name TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_folder_idx ON files(folder_id);
CREATE INDEX IF NOT EXISTS files_name_idx ON files(name);
CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY, file_id TEXT, name TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  name TEXT NOT NULL, blob_name TEXT NOT NULL UNIQUE, size INTEGER NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, message TEXT NOT NULL,
  detail_json TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activity_created_idx ON activity(created_at DESC);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
);
