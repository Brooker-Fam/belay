-- Belay server schema, version 1. Times are integers: milliseconds since the epoch, UTC.
-- Secrets (session ids, tokens, codes) are stored only as SHA-256 hashes (hex).

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                       -- JSON
) STRICT;

CREATE TABLE parents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,              -- argon2id, PHC string
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_parent ON sessions(parent_id);

CREATE TABLE invites (
  token_hash TEXT PRIMARY KEY,
  created_by TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT UNIQUE,                   -- NULL once a parent disconnects the phone
  enrolled_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_seen_at INTEGER,                     -- any call with the device token
  last_checkin_at INTEGER,
  last_inventory_at INTEGER,                -- server time the last snapshot arrived
  facts TEXT,                               -- JSON: the last Device object (docs/protocol.md)
  facts_at INTEGER
) STRICT;

CREATE TABLE enrollment_codes (
  code_hash TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,  -- set: reconnects that phone
  created_by TEXT REFERENCES parents(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_device TEXT REFERENCES devices(id) ON DELETE SET NULL
) STRICT;

-- Current state of each package on each phone, including removed ones (present = 0),
-- so a reinstall is recognized and review history stays attached.
CREATE TABLE apps (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  package TEXT NOT NULL,
  label TEXT NOT NULL,
  version_name TEXT,
  version_code INTEGER NOT NULL,
  first_install_time INTEGER,
  last_update_time INTEGER,
  system INTEGER NOT NULL DEFAULT 0,
  updated_system INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  launchable INTEGER NOT NULL DEFAULT 1,
  target_sdk INTEGER,
  category INTEGER,
  source TEXT NOT NULL DEFAULT 'unknown',
  installer TEXT,                           -- JSON
  permissions TEXT NOT NULL DEFAULT '[]',   -- JSON array of category names
  details_known INTEGER NOT NULL DEFAULT 0, -- 1 once a full Package object has been seen
  present INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,           -- server time it was first known
  install_seen_at INTEGER NOT NULL,         -- server time its latest install or reinstall was recorded
  removed_at INTEGER,                       -- server time its removal was recorded
  PRIMARY KEY (device_id, package)
) STRICT;

CREATE TABLE app_events (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                         -- the phone's UUID, or the server's for a backfill
  kind TEXT NOT NULL CHECK (kind IN ('installed', 'updated', 'removed', 'reinstalled')),
  package TEXT NOT NULL,
  label TEXT NOT NULL,
  from_name TEXT,
  from_code INTEGER,
  to_name TEXT,
  to_code INTEGER,
  happened_at INTEGER,
  detected_at INTEGER NOT NULL,
  detection TEXT NOT NULL,                  -- broadcast, changed_packages, snapshot
  backfilled INTEGER NOT NULL DEFAULT 0,    -- 1: the server found it in a snapshot
  received_at INTEGER NOT NULL,
  at INTEGER NOT NULL,                      -- when it happened, as best known: see device/apps.ts
  PRIMARY KEY (device_id, id)
) STRICT;
CREATE INDEX app_events_at ON app_events(at);
CREATE INDEX app_events_package ON app_events(device_id, package, at);

CREATE TABLE snapshots (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  boot_count INTEGER,
  package_count INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  backfilled INTEGER NOT NULL,              -- changes the server found in it
  PRIMARY KEY (device_id, snapshot_id)
) STRICT;

-- Every review is kept: "why did we decide that?" always has an answer.
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  package TEXT NOT NULL,
  reviewed_at INTEGER NOT NULL,
  parent_id TEXT REFERENCES parents(id) ON DELETE SET NULL,
  via TEXT NOT NULL,                        -- 'web' or the AI client's name, e.g. 'Claude'
  note TEXT,
  version_code INTEGER,
  permissions TEXT NOT NULL DEFAULT '[]'    -- what it held when reviewed
) STRICT;
CREATE INDEX reviews_app ON reviews(device_id, package, reviewed_at);

-- Clients that registered with Dynamic Client Registration (RFC 7591).
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT NOT NULL,                -- chosen by the client: untrusted
  redirect_uris TEXT NOT NULL,              -- JSON array
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  grant_id TEXT
) STRICT;

-- One connected AI app (an OAuth grant) or one personal access token.
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('oauth', 'pat')),
  parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  client_id TEXT,
  client_name TEXT NOT NULL,                -- what the parent saw on the consent screen, or the token's name
  client_host TEXT,
  redirect_uri TEXT,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  refresh_allowed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
) STRICT;

CREATE TABLE access_tokens (
  token_hash TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh', 'pat')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,                       -- NULL: until revoked (personal access tokens)
  used_at INTEGER                           -- refresh tokens: set when exchanged (reuse revokes the grant)
) STRICT;
CREATE INDEX access_tokens_grant ON access_tokens(grant_id);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('parent', 'ai', 'phone', 'server')),
  parent_id TEXT REFERENCES parents(id) ON DELETE SET NULL,
  client_name TEXT,                         -- for 'ai': the connected app, e.g. 'Claude'
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT                               -- JSON
) STRICT;
CREATE INDEX audit_log_at ON audit_log(at);
