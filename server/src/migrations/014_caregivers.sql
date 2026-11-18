-- Belay server schema, version 14 (Phase 12): caregivers (docs/design/phase12-caregivers.md). A
-- parent gives someone else (a grandparent for a weekend, a babysitter, a coach on a trip, the
-- kid's other household) limited access to some of the family's phones, until a time at most 30
-- days ahead: the phone's status, pausing or locking it (only ever tighter), the kid's "I need
-- help", and checking where it is now. A caregiver is never a parent: their accounts, sessions and
-- browsers are here, read only by the caregiver pages (/care), never by a parent page, MCP or
-- OAuth. Phase 13's mobile data, built alongside, takes number 15. Times are integers:
-- milliseconds since the epoch, UTC.

CREATE TABLE caregivers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- the parent's words ("Grandma"), one line, at most 40 characters: the kid sees it
  username TEXT UNIQUE COLLATE NOCASE,      -- chosen with the one-time link; NULL until then
  password_hash TEXT,                       -- argon2id, PHC string; NULL until then
  can_status INTEGER NOT NULL CHECK (can_status IN (0, 1)),  -- online, battery, paused, the schedule now
  can_pause INTEGER NOT NULL CHECK (can_pause IN (0, 1)),    -- pause, or pause and lock now: only ever tighter
  can_help INTEGER NOT NULL CHECK (can_help IN (0, 1)),      -- the kid's "I need help", by push and on their page
  can_locate INTEGER NOT NULL CHECK (can_locate IN (0, 1)),  -- check where the phone is now, while location is on
  access_from INTEGER NOT NULL,             -- when this access began: help requests from before it don't show
  ends_at INTEGER NOT NULL,                 -- when access ends by itself: at most 30 days after a parent set it
  ended_at INTEGER,                         -- once access ended: a parent's "End access now", or the hourly clean-up at ends_at
  ended_by TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- NULL: its time came
  created_by TEXT REFERENCES parents(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  joined_at INTEGER,                        -- when they first chose a password
  last_signed_in_at INTEGER
) STRICT;

-- The phones a caregiver's access covers. A phone deleted takes its rows.
CREATE TABLE caregiver_phones (
  caregiver_id TEXT NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  PRIMARY KEY (caregiver_id, device_id)
) STRICT;
CREATE INDEX caregiver_phones_device ON caregiver_phones(device_id);

-- One-time links (/care/join/<token>): with one, the caregiver chooses a username and password.
-- Only the hash is kept; each works once, for 7 days at most and never after access ends.
CREATE TABLE caregiver_links (
  token_hash TEXT PRIMARY KEY,
  caregiver_id TEXT NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES parents(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
) STRICT;
CREATE INDEX caregiver_links_caregiver ON caregiver_links(caregiver_id);

-- A caregiver's sessions (the cookie belay_care), never a parent's: parent pages read only
-- `sessions`, joined to parents. Only the cookie's hash is kept.
CREATE TABLE caregiver_sessions (
  id_hash TEXT PRIMARY KEY,
  caregiver_id TEXT NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX caregiver_sessions_caregiver ON caregiver_sessions(caregiver_id);

-- Browsers a caregiver turned notifications on in (Web Push, end-to-end encrypted, as a parent's):
-- only the kid's help requests go to them. Apart from push_subscriptions, which only parents' notices read.
CREATE TABLE caregiver_push (
  id TEXT PRIMARY KEY,
  caregiver_id TEXT NOT NULL REFERENCES caregivers(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,            -- at a known push service; a capability URL, never logged
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  name TEXT NOT NULL,                       -- "Safari on iPhone"
  created_at INTEGER NOT NULL,
  last_sent_at INTEGER
) STRICT;
CREATE INDEX caregiver_push_caregiver ON caregiver_push(caregiver_id);

-- Who set the pause in force, when a caregiver did (their name then: the policy's pause.caregiver,
-- so the kid's phone says "Paused by Grandma"); NULL for a parent's, an AI app's or the CLI's.
ALTER TABLE policies ADD COLUMN pause_caregiver TEXT;

-- The caregiver who sent a lock_now or locate_now (the policy's commands[].caregiver, for the kid's notice).
ALTER TABLE commands ADD COLUMN caregiver_id TEXT REFERENCES caregivers(id) ON DELETE SET NULL;
ALTER TABLE commands ADD COLUMN caregiver_name TEXT;

-- The activity log gains the actor 'caregiver', with the caregiver's name then, kept when the
-- account goes. Made again for its CHECK constraint; no other table refers to it.
CREATE TABLE audit_log_v14 (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('parent', 'ai', 'phone', 'server', 'caregiver')),
  parent_id TEXT REFERENCES parents(id) ON DELETE SET NULL,
  client_name TEXT,                         -- for 'ai': the connected app, e.g. 'Claude'
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  detail TEXT,                              -- JSON
  caregiver_id TEXT REFERENCES caregivers(id) ON DELETE SET NULL,
  caregiver_name TEXT                       -- for 'caregiver': their name when they did it
) STRICT;
INSERT INTO audit_log_v14 (id, at, actor, parent_id, client_name, device_id, action, detail)
  SELECT id, at, actor, parent_id, client_name, device_id, action, detail FROM audit_log ORDER BY id;
DROP TABLE audit_log;
ALTER TABLE audit_log_v14 RENAME TO audit_log;
CREATE INDEX audit_log_at ON audit_log(at);
