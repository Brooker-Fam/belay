-- Belay server schema, version 6 (Phases 4 and 7): where the phone is, the family's places,
-- arrivals and departures and lost mode (docs/design/phase4-location.md), and the kid's side:
-- "I need help", "Talk to my parent", withdrawing a request, and the numbers for "Call" and the
-- emergency card (docs/design/phase7-kid-side.md). Times are integers: milliseconds since the
-- epoch, UTC.

-- The kid's requests gain Phase 7's kinds: "I need help" (urgent: it stays at the top of the
-- parent page until a parent has seen it) and "Talk to my parent"; and any request the kid
-- withdraws while it's pending. Made again for its CHECK constraints; no other table refers to it.
CREATE TABLE requests_v6 (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                         -- the phone's UUID
  kind TEXT NOT NULL CHECK (kind IN ('app', 'more_time', 'agreement', 'help', 'talk')),
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
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'talk', 'superseded', 'withdrawn')),
  note TEXT,                                -- the parent's answer, shown to the kid
  answered_by TEXT REFERENCES parents(id) ON DELETE SET NULL,
  answered_at INTEGER,
  superseded_by TEXT,                       -- for 'superseded': the newer request that took its place
  withdrawn_at INTEGER,                     -- for 'withdrawn': when the kid withdrew it (the phone's clock)
  seen_at INTEGER,                          -- help: when a parent saw it (a help request is seen, not answered)
  seen_by TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- help: who saw it; NULL with seen_at: the server's CLI
  PRIMARY KEY (device_id, id),
  CHECK (kind != 'app' OR (package IS NOT NULL AND label IS NOT NULL)),
  CHECK (kind != 'more_time' OR (limit_id IS NOT NULL AND minutes IS NOT NULL)),
  CHECK (kind != 'agreement' OR (agreement_version IS NOT NULL AND agreement_answer IS NOT NULL)),
  CHECK (status != 'withdrawn' OR withdrawn_at IS NOT NULL),
  CHECK (kind = 'help' OR seen_at IS NULL)
) STRICT;
INSERT INTO requests_v6 (device_id, id, kind, package, label, reason, limit_id, minutes, given_minutes, extra_id, agreement_version, agreement_answer,
    asked_at, received_at, updated_at, status, note, answered_by, answered_at, superseded_by)
  SELECT device_id, id, kind, package, label, reason, limit_id, minutes, given_minutes, extra_id, agreement_version, agreement_answer,
    asked_at, received_at, updated_at, status, note, answered_by, answered_at, superseded_by
  FROM requests ORDER BY rowid;
DROP TABLE requests;
ALTER TABLE requests_v6 RENAME TO requests;
CREATE INDEX requests_received ON requests(device_id, received_at);
CREATE INDEX requests_status ON requests(status, received_at);
CREATE INDEX requests_package ON requests(device_id, package);
CREATE INDEX requests_kind ON requests(kind, seen_at);

-- Phase 4's locate_now command: take one fix now and send it. Made again for its CHECK
-- constraint; no other table refers to it. client_name is the AI app a parent used, if one did:
-- the policy names it (`via`), for the kid's notice.
CREATE TABLE commands_v6 (
  id TEXT PRIMARY KEY,                      -- the server's UUID: the phone runs each id once
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('remove_other_users', 'lock_now', 'locate_now')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER,                       -- NULL: no limit
  issued_by TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- NULL: the server's CLI
  client_name TEXT,                         -- an AI app that issued it, through issued_by's connection
  result TEXT CHECK (result IN ('done', 'failed', 'expired')),  -- NULL until the phone reports it
  result_at INTEGER,                        -- the phone's clock
  problem TEXT,                             -- the phone's words when it failed: untrusted
  reported_at INTEGER,                      -- when the server heard
  replaced_at INTEGER                       -- a newer one of its kind took its place before a result
) STRICT;
INSERT INTO commands_v6 (id, device_id, kind, issued_at, expires_at, issued_by, client_name, result, result_at, problem, reported_at, replaced_at)
  SELECT id, device_id, kind, issued_at, expires_at, issued_by, client_name, result, result_at, problem, reported_at, replaced_at FROM commands ORDER BY rowid;
DROP TABLE commands;
ALTER TABLE commands_v6 RENAME TO commands;
CREATE INDEX commands_device ON commands(device_id, issued_at);

-- Each phone's location settings (the policy's `location`), a parent's alone: never an AI app's,
-- not even as a proposal. A phone without a row has no location at all (`location` is null).
CREATE TABLE location_settings (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off', 'on_demand', 'periodic')),
  every_minutes INTEGER NOT NULL DEFAULT 30 CHECK (every_minutes BETWEEN 15 AND 120),  -- periodic
  hours_start TEXT,                         -- periodic fixes only from then ("HH:MM", the phone's time)
  hours_end TEXT,                           -- to then; both NULL: all day
  provider TEXT NOT NULL DEFAULT 'gps' CHECK (provider IN ('gps', 'fused')),
  fallback_fused INTEGER NOT NULL DEFAULT 0 CHECK (fallback_fused IN (0, 1)),
  keep_on INTEGER NOT NULL DEFAULT 0 CHECK (keep_on IN (0, 1)),
  lost_since INTEGER,                       -- lost mode is on since then; NULL: off
  lost_message TEXT,                        -- the parent's words for the lock screen
  lost_number TEXT,                         -- a number to show with them
  lost_ended_at INTEGER,                    -- when lost mode last ended
  dropped INTEGER NOT NULL DEFAULT 0,       -- fixes and place events sent that the rules didn't ask for: not kept
  dropped_at INTEGER,                       -- the last time one was dropped
  changed_at INTEGER NOT NULL,
  CHECK ((hours_start IS NULL) = (hours_end IS NULL))
) STRICT;

-- The places a parent named for each phone. Only periodic mode uses them; the kid sees their names.
CREATE TABLE places (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                         -- the server's ("p-…"), as the policy and place events name it
  name TEXT NOT NULL,                       -- the family's words, at most 40 characters
  lat REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  radius_m INTEGER NOT NULL CHECK (radius_m BETWEEN 50 AND 1000),
  notify_arrive INTEGER NOT NULL DEFAULT 0 CHECK (notify_arrive IN (0, 1)),  -- push to the parents on arriving
  notify_leave INTEGER NOT NULL DEFAULT 0 CHECK (notify_leave IN (0, 1)),    -- and on leaving
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, id)
) STRICT;

-- Where the phone was (POST /api/v1/locations, and a help request's shared fix), kept only as the
-- phone's rules allow: periodic fixes 7 days, a parent's checks 30 days, lost-mode fixes until
-- 7 days after lost mode ends (the family's settings), a help request's fix with the request.
CREATE TABLE fixes (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                         -- the phone's UUID
  at INTEGER NOT NULL,                      -- the fix's own time (the phone's clock)
  lat REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),     -- 5 decimal places (about 1 m)
  lng REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m INTEGER NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('gps', 'fused')),
  reason TEXT NOT NULL CHECK (reason IN ('on_demand', 'periodic', 'place', 'lost', 'help')),
  command_id TEXT,                          -- on_demand: the locate_now it answers
  request_id TEXT,                          -- help: the help request it came with
  mock INTEGER NOT NULL CHECK (mock IN (0, 1)),  -- Android says an app made it up: it never counts for places
  received_at INTEGER NOT NULL,
  lost_ended_at INTEGER,                    -- lost: when the lost mode it was taken in ended (NULL while it's on)
  PRIMARY KEY (device_id, id)
) STRICT;
CREATE INDEX fixes_at ON fixes(device_id, at);
CREATE INDEX fixes_command ON fixes(device_id, command_id);
CREATE INDEX fixes_request ON fixes(device_id, request_id);

-- Arrivals and departures the phone worked out (periodic mode), kept 90 days (a setting).
CREATE TABLE place_events (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                         -- the phone's UUID
  place_id TEXT NOT NULL,                   -- the place; it may have been removed since
  place_name TEXT NOT NULL,                 -- its name when it happened (the family's words)
  kind TEXT NOT NULL CHECK (kind IN ('arrived', 'left')),
  at INTEGER NOT NULL,                      -- the phone's clock
  fix_id TEXT NOT NULL,                     -- the fix that decided it
  received_at INTEGER NOT NULL,
  notified_at INTEGER,                      -- when the parents were told, if they were
  PRIMARY KEY (device_id, id)
) STRICT;
CREATE INDEX place_events_at ON place_events(device_id, at);

-- Phase 7, per phone: the kid's own number, for "Call" beside a help request (it's never sent to
-- the phone), and the numbers on the phone's emergency card when this phone has its own (NULL: the
-- family's, from Settings).
CREATE TABLE phone_help (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  kid_number TEXT,                          -- E.164
  parent_numbers TEXT,                      -- JSON: [{name, number}], at most 4; NULL: the family's
  changed_at INTEGER NOT NULL
) STRICT;
