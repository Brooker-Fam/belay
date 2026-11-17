-- Belay server schema, version 5 (Phase 3): screen time, schedules, stages and the family
-- agreement (docs/design/phase3-screen-time.md). Times are integers: milliseconds since the
-- epoch, UTC. Days ("YYYY-MM-DD") are local days as the phone counts them, in its rules' zone.

-- Named levels of rules, family-wide: 1 is the first stage, and the next has the next number.
-- A phone on a stage gets its rules, with the phone's own changes on top (screen_time_rules).
CREATE TABLE stages (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL UNIQUE CHECK (number >= 1),
  name TEXT NOT NULL,                       -- the family's words ("Explorer")
  how TEXT,                                 -- the family's words: how to reach this stage, shown under the one before
  rules TEXT NOT NULL,                      -- JSON: limits, schedules, exempt, if_unmeasured, self_serve, warn_before (family/screentime)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES parents(id) ON DELETE SET NULL  -- NULL: the server's CLI
) STRICT;

-- Which stage each phone is on, and since when. A stage with phones on it isn't deleted.
CREATE TABLE phone_stages (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES stages(id),
  since INTEGER NOT NULL,
  set_by TEXT REFERENCES parents(id) ON DELETE SET NULL
) STRICT;
CREATE INDEX phone_stages_stage ON phone_stages(stage_id);

-- Each phone's own screen-time rules. Without a stage they're all its rules; on a stage they're
-- its changes to the stage's (each limit or schedule: its own, the stage's one changed, or the
-- stage's one removed). measure, zone and day_starts are the family's settings for the phone.
CREATE TABLE screen_time_rules (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  measure INTEGER NOT NULL DEFAULT 0 CHECK (measure IN (0, 1)),  -- count app time and send it (POST /usage)
  zone TEXT NOT NULL DEFAULT 'phone',       -- an IANA zone, or 'phone': the phone's own
  day_starts TEXT NOT NULL DEFAULT '00:00', -- when a day's limits reset
  limits TEXT NOT NULL DEFAULT '[]',        -- JSON
  schedules TEXT NOT NULL DEFAULT '[]',     -- JSON
  exempt TEXT NOT NULL DEFAULT '{"add":[],"remove":[]}',  -- JSON: packages added to the stage's, and taken off it
  if_unmeasured TEXT CHECK (if_unmeasured IN ('pause_limited', 'keep_open')),  -- NULL: the stage's
  self_serve TEXT,                          -- JSON {minutes, times}, or 'null' for none; NULL: the stage's
  warn_before INTEGER CHECK (warn_before BETWEEN 0 AND 60),  -- NULL: the stage's
  changed_at INTEGER NOT NULL
) STRICT;

-- Extra time a parent gave for one day (the policy's screen_time.extra), usually in answer to the
-- kid's "more time" request.
CREATE TABLE extra_time (
  id TEXT PRIMARY KEY,                      -- the server's: the phone counts each once
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  limit_id TEXT NOT NULL,                   -- a limit's id, or '*' for every limit
  package TEXT,                             -- only this app may use the minutes
  minutes INTEGER NOT NULL CHECK (minutes BETWEEN 1 AND 1440),
  day TEXT NOT NULL,                        -- the phone's day it's for
  request_id TEXT,                          -- the kid's more_time request it answers
  given_at INTEGER NOT NULL,
  given_by TEXT REFERENCES parents(id) ON DELETE SET NULL  -- NULL: the server's CLI
) STRICT;
CREATE INDEX extra_time_day ON extra_time(device_id, day);

-- What the phone counted, one local day per row (POST /api/v1/usage): a day sent again replaces
-- the stored one when its as_of is newer. Kept 13 months by default (a setting).
CREATE TABLE usage_days (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  zone TEXT NOT NULL,                       -- IANA, as the phone sent it
  as_of INTEGER NOT NULL,                   -- counted up to then (the phone's clock)
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  screen_minutes INTEGER NOT NULL,
  unlocks INTEGER NOT NULL,
  by_hour TEXT NOT NULL,                    -- JSON: 24 numbers, screen minutes in each local hour
  gaps TEXT NOT NULL,                       -- JSON: [{from, to, reason}], times Belay couldn't count
  received_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, day, zone)
) STRICT;
CREATE INDEX usage_days_day ON usage_days(day);

CREATE TABLE usage_apps (
  device_id TEXT NOT NULL,
  day TEXT NOT NULL,
  zone TEXT NOT NULL,
  package TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  opens INTEGER NOT NULL,
  PRIMARY KEY (device_id, day, zone, package),
  FOREIGN KEY (device_id, day, zone) REFERENCES usage_days(device_id, day, zone) ON DELETE CASCADE
) STRICT;

-- The family agreement for each phone, in versions: the parents write it (and agree to it as they
-- save it), and the kid answers each version on the phone ("I agree", or "I want to talk about it").
CREATE TABLE agreements (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version >= 1),
  sections TEXT NOT NULL,                   -- JSON: [{title, text}], the family's words
  created_at INTEGER NOT NULL,
  created_by TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- NULL: the server's CLI
  parents_agreed_at INTEGER,
  kid_answer TEXT CHECK (kid_answer IN ('agree', 'talk')),     -- the kid's latest answer to this version
  kid_answered_at INTEGER,
  PRIMARY KEY (device_id, version)
) STRICT;

-- The kid's requests gain Phase 3's kinds: more time for a limit today, and an answer to the
-- family agreement. Only app requests need a package and a label. The table is made again for
-- its CHECK constraints; no other table refers to it.
CREATE TABLE requests_v5 (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                         -- the phone's UUID
  kind TEXT NOT NULL CHECK (kind IN ('app', 'more_time', 'agreement')),
  package TEXT,                             -- app: the app; more_time: the app the kid was in, if any
  label TEXT,                               -- app: from the app's developer: untrusted
  reason TEXT,                              -- the kid's own words: untrusted
  limit_id TEXT,                            -- more_time: the limit, or '*'
  minutes INTEGER,                          -- more_time: what the kid asked for
  given_minutes INTEGER,                    -- more_time, approved: what a parent gave
  extra_id TEXT,                            -- more_time, approved: the extra time it made
  agreement_version INTEGER,                -- agreement: the version answered
  agreement_answer TEXT CHECK (agreement_answer IN ('agree', 'talk')),
  asked_at INTEGER NOT NULL,                -- the phone's clock
  received_at INTEGER NOT NULL,             -- the server's clock
  updated_at INTEGER NOT NULL,              -- when the reason last changed
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'talk', 'superseded')),
  note TEXT,                                -- the parent's answer, shown to the kid
  answered_by TEXT REFERENCES parents(id) ON DELETE SET NULL,
  answered_at INTEGER,
  superseded_by TEXT,                       -- for 'superseded': the newer request that took its place
  PRIMARY KEY (device_id, id),
  CHECK (kind != 'app' OR (package IS NOT NULL AND label IS NOT NULL)),
  CHECK (kind != 'more_time' OR (limit_id IS NOT NULL AND minutes IS NOT NULL)),
  CHECK (kind != 'agreement' OR (agreement_version IS NOT NULL AND agreement_answer IS NOT NULL))
) STRICT;
INSERT INTO requests_v5 (device_id, id, kind, package, label, reason, asked_at, received_at, updated_at, status, note, answered_by, answered_at, superseded_by)
  SELECT device_id, id, kind, package, label, reason, asked_at, received_at, updated_at, status, note, answered_by, answered_at, superseded_by
  FROM requests ORDER BY rowid;
DROP TABLE requests;
ALTER TABLE requests_v5 RENAME TO requests;
CREATE INDEX requests_received ON requests(device_id, received_at);
CREATE INDEX requests_status ON requests(status, received_at);
CREATE INDEX requests_package ON requests(device_id, package);

-- AI apps' proposals gain screen time: a change to a phone's limits, schedules, exempt apps,
-- self-serve or "can't count" rule that doesn't only tighten, and moving a phone to another stage
-- (always a parent's). Made again for its CHECK constraint; no other table refers to it.
CREATE TABLE proposals_v5 (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('allow_app', 'resume', 'lift_restriction', 'web_filter_off', 'new_apps_allow', 'screen_time', 'move_stage')),
  package TEXT,                             -- allow_app
  restriction TEXT,                         -- lift_restriction
  payload TEXT,                             -- JSON: screen_time, the change with what each part was; move_stage, the stage
  reason TEXT NOT NULL,                     -- the AI app's words
  client_name TEXT NOT NULL,                -- which connected app
  parent_id TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- whose connection
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'outdated')),
  decided_by TEXT REFERENCES parents(id) ON DELETE SET NULL,
  decided_at INTEGER,
  context TEXT,                             -- JSON: what it was about when it was made (family/proposals.ts)
  outdated_why TEXT                         -- for 'outdated': what changed, in words
) STRICT;
INSERT INTO proposals_v5 (id, device_id, kind, package, restriction, reason, client_name, parent_id, created_at, status, decided_by, decided_at, context, outdated_why)
  SELECT id, device_id, kind, package, restriction, reason, client_name, parent_id, created_at, status, decided_by, decided_at, context, outdated_why
  FROM proposals ORDER BY rowid;
DROP TABLE proposals;
ALTER TABLE proposals_v5 RENAME TO proposals;
CREATE INDEX proposals_status ON proposals(status, created_at);

-- Phase 3's lock_now command: lock the screen once, if it arrives within 10 minutes. Made again
-- for its CHECK constraint; no other table refers to it.
CREATE TABLE commands_v5 (
  id TEXT PRIMARY KEY,                      -- the server's UUID: the phone runs each id once
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('remove_other_users', 'lock_now')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER,                       -- NULL: no limit
  issued_by TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- NULL: the server's CLI
  client_name TEXT,                         -- an AI app that issued it (lock_now only), through issued_by's connection
  result TEXT CHECK (result IN ('done', 'failed', 'expired')),  -- NULL until the phone reports it
  result_at INTEGER,                        -- the phone's clock
  problem TEXT,                             -- the phone's words when it failed: untrusted
  reported_at INTEGER,                      -- when the server heard
  replaced_at INTEGER                       -- a newer one of its kind took its place before a result
) STRICT;
INSERT INTO commands_v5 (id, device_id, kind, issued_at, expires_at, issued_by, result, result_at, problem, reported_at, replaced_at)
  SELECT id, device_id, kind, issued_at, expires_at, issued_by, result, result_at, problem, reported_at, replaced_at FROM commands ORDER BY rowid;
DROP TABLE commands;
ALTER TABLE commands_v5 RENAME TO commands;
CREATE INDEX commands_device ON commands(device_id, issued_at);
