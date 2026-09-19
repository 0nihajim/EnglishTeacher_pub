CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL CHECK (mode IN ('scene', 'drill', 'retell', 'review')),
  label TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'active', 'ended', 'interrupted', 'failed')),
  recording_status TEXT NOT NULL DEFAULT 'not_saved'
    CHECK (recording_status IN ('not_saved', 'reserved', 'available', 'expired')),
  model TEXT NOT NULL
);
CREATE INDEX sessions_by_user ON sessions(user_id, started_at DESC, id DESC);
CREATE UNIQUE INDEX one_active_session_per_user ON sessions(user_id)
  WHERE status IN ('created', 'active');

CREATE TABLE turns (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX turns_in_order ON turns(session_id, seq);

CREATE TABLE notes (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  at INTEGER NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX notes_in_order ON notes(session_id, seq);

CREATE TABLE results (
  user_id TEXT NOT NULL REFERENCES users(id),
  event_id TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  scene_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX results_by_scene ON results(user_id, scene_id, at, event_id);
CREATE INDEX results_by_kind ON results(user_id, kind, at);

CREATE TABLE result_cards (
  user_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  card_id TEXT NOT NULL,
  PRIMARY KEY (user_id, card_id, event_id),
  FOREIGN KEY (user_id, event_id) REFERENCES results(user_id, event_id)
);

CREATE TABLE review_cards (
  user_id TEXT NOT NULL REFERENCES users(id),
  id TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  lapses INTEGER NOT NULL,
  last_review_at INTEGER,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  PRIMARY KEY (user_id, id)
);
CREATE INDEX review_due ON review_cards(user_id, due_at, lapses DESC, id);

CREATE TABLE recording_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  paused INTEGER NOT NULL DEFAULT 0
);
INSERT INTO recording_budget (id) VALUES (1);

CREATE TABLE recordings (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  object_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'uploading', 'ready', 'deleting', 'deleted')),
  reserved_bytes INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  reserved_until INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  sha256 TEXT
);
CREATE INDEX recordings_to_expire ON recordings(status, expires_at);
CREATE INDEX recording_reservations ON recordings(status, reserved_until);
