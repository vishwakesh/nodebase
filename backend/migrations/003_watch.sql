CREATE TABLE IF NOT EXISTS watch_rooms (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'General',
  visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','discoverable_private')),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','playing','paused','ended','expired')),
  current_video_file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  participant_limit INTEGER NOT NULL DEFAULT 12 CHECK(participant_limit BETWEEN 2 AND 50),
  approval_required INTEGER NOT NULL DEFAULT 0,
  chat_enabled INTEGER NOT NULL DEFAULT 1,
  viewer_control_enabled INTEGER NOT NULL DEFAULT 0,
  playback_state TEXT NOT NULL DEFAULT 'paused' CHECK(playback_state IN ('playing','paused','ended')),
  playback_position_ms INTEGER NOT NULL DEFAULT 0 CHECK(playback_position_ms >= 0),
  playback_rate REAL NOT NULL DEFAULT 1.0 CHECK(playback_rate BETWEEN 0.5 AND 2.0),
  playback_sequence INTEGER NOT NULL DEFAULT 0 CHECK(playback_sequence >= 0),
  playback_updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS watch_rooms_owner_idx ON watch_rooms(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS watch_rooms_discovery_idx ON watch_rooms(visibility, status, created_at DESC);

CREATE TABLE IF NOT EXISTS watch_participants (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES watch_rooms(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES admin(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('host','cohost','viewer')),
  status TEXT NOT NULL DEFAULT 'joined' CHECK(status IN ('pending','joined','left','removed')),
  session_hash TEXT UNIQUE,
  joined_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  left_at TEXT,
  UNIQUE(room_id, user_id)
);
CREATE INDEX IF NOT EXISTS watch_participants_room_idx ON watch_participants(room_id, status, joined_at);
CREATE INDEX IF NOT EXISTS watch_participants_session_idx ON watch_participants(session_hash);

CREATE TABLE IF NOT EXISTS watch_invitations (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES watch_rooms(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  max_uses INTEGER NOT NULL DEFAULT 20 CHECK(max_uses BETWEEN 1 AND 500),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count >= 0),
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS watch_invitations_room_idx ON watch_invitations(room_id, created_at DESC);
CREATE INDEX IF NOT EXISTS watch_invitations_expiry_idx ON watch_invitations(expires_at);

CREATE TABLE IF NOT EXISTS watch_queue_items (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES watch_rooms(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  added_by TEXT NOT NULL REFERENCES admin(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(room_id, position)
);
CREATE INDEX IF NOT EXISTS watch_queue_room_idx ON watch_queue_items(room_id, position);

CREATE TABLE IF NOT EXISTS watch_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES watch_rooms(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES watch_participants(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS watch_messages_room_idx ON watch_messages(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS watch_room_events (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES watch_rooms(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(room_id, sequence)
);
CREATE INDEX IF NOT EXISTS watch_room_events_room_idx ON watch_room_events(room_id, sequence DESC);
