-- Belay server schema, version 7 (Phase 5, calls): who may call the kid and whom the kid may call,
-- the contacts a parent approved, the numbers Belay never records and the ones a parent blocked,
-- and the calls' records (docs/design/phase5-calls-texts.md). 911, every emergency number and 988
-- are never in any of these: the phone allows them in its own code, and records none of them.
-- Times are integers: milliseconds since the epoch, UTC.

-- The kid's requests gain Phase 5's "Please add this contact": the name and number the kid gave
-- (their words: untrusted), and the contact a parent's approval made (or the one that already had
-- the number). Made again for its CHECK constraints; no other table refers to it.
CREATE TABLE requests_v7 (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                         -- the phone's UUID
  kind TEXT NOT NULL CHECK (kind IN ('app', 'more_time', 'agreement', 'help', 'talk', 'contact')),
  package TEXT,                             -- app: the app; more_time: the app the kid was in, if any
  label TEXT,                               -- app: from the app's developer: untrusted
  reason TEXT,                              -- the kid's own words: untrusted
  limit_id TEXT,                            -- more_time: the limit, or '*'
  minutes INTEGER,                          -- more_time: what the kid asked for
  given_minutes INTEGER,                    -- more_time, approved: what a parent gave
  extra_id TEXT,                            -- more_time, approved: the extra time it made
  agreement_version INTEGER,                -- agreement: the version answered
  agreement_answer TEXT CHECK (agreement_answer IN ('agree', 'talk')),
  contact_name TEXT,                        -- contact: the name the kid gave: untrusted
  contact_number TEXT,                      -- contact: the number, E.164
  contact_id TEXT,                          -- contact, approved: the contact it made, or the one that had the number
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
  CHECK (kind != 'contact' OR (contact_name IS NOT NULL AND contact_number IS NOT NULL)),
  CHECK (status != 'withdrawn' OR withdrawn_at IS NOT NULL),
  CHECK (kind = 'help' OR seen_at IS NULL)
) STRICT;
INSERT INTO requests_v7 (device_id, id, kind, package, label, reason, limit_id, minutes, given_minutes, extra_id, agreement_version, agreement_answer,
    asked_at, received_at, updated_at, status, note, answered_by, answered_at, superseded_by, withdrawn_at, seen_at, seen_by)
  SELECT device_id, id, kind, package, label, reason, limit_id, minutes, given_minutes, extra_id, agreement_version, agreement_answer,
    asked_at, received_at, updated_at, status, note, answered_by, answered_at, superseded_by, withdrawn_at, seen_at, seen_by
  FROM requests ORDER BY rowid;
DROP TABLE requests;
ALTER TABLE requests_v7 RENAME TO requests;
CREATE INDEX requests_received ON requests(device_id, received_at);
CREATE INDEX requests_status ON requests(status, received_at);
CREATE INDEX requests_package ON requests(device_id, package);
CREATE INDEX requests_kind ON requests(kind, seen_at);
CREATE INDEX requests_contact ON requests(device_id, contact_number);

-- AI apps' proposals gain calls: a change to who may call the kid, whom the kid may call, the
-- contacts or the blocked numbers that doesn't only tighten. Turning calls on or off, recording
-- them and the private numbers are never proposed: they're a parent's alone. Made again for its
-- CHECK constraint; no other table refers to it.
CREATE TABLE proposals_v7 (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('allow_app', 'resume', 'lift_restriction', 'web_filter_off', 'new_apps_allow', 'screen_time', 'move_stage', 'calls')),
  package TEXT,                             -- allow_app
  restriction TEXT,                         -- lift_restriction
  payload TEXT,                             -- JSON: screen_time and calls, the change with what each part was; move_stage, the stage
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
INSERT INTO proposals_v7 (id, device_id, kind, package, restriction, payload, reason, client_name, parent_id, created_at, status, decided_by, decided_at, context, outdated_why)
  SELECT id, device_id, kind, package, restriction, payload, reason, client_name, parent_id, created_at, status, decided_by, decided_at, context, outdated_why
  FROM proposals ORDER BY rowid;
DROP TABLE proposals;
ALTER TABLE proposals_v7 RENAME TO proposals;
CREATE INDEX proposals_status ON proposals(status, created_at);

-- Each phone's call rules (the policy's `calls`). A phone without a row, or with enabled = 0, has
-- calls left alone (`calls` is null: Belay isn't the phone app); the rules are kept while calls
-- are off, for when a parent turns them on again. Turning calls on or off, and `log`, are a
-- parent's alone: never an AI app's, not even as a proposal.
CREATE TABLE call_settings (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  mode TEXT NOT NULL DEFAULT 'open' CHECK (mode IN ('open', 'contacts')),
  unknown TEXT NOT NULL DEFAULT 'voicemail' CHECK (unknown IN ('reject', 'voicemail', 'ring')),
  withheld TEXT NOT NULL DEFAULT 'voicemail' CHECK (withheld IN ('reject', 'voicemail', 'ring')),
  outgoing TEXT NOT NULL DEFAULT 'any' CHECK (outgoing IN ('contacts', 'any')),
  quiet INTEGER NOT NULL DEFAULT 0 CHECK (quiet IN (0, 1)),
  log INTEGER NOT NULL DEFAULT 0 CHECK (log IN (0, 1)),  -- send call records
  enabled_at INTEGER,                       -- when calls were last turned on
  dropped INTEGER NOT NULL DEFAULT 0,       -- call records the phone sent that weren't kept (not recording, or too many in a day)
  dropped_at INTEGER,                       -- the last time one was
  changed_at INTEGER NOT NULL
) STRICT;

-- The contacts a parent approved for each phone (the policy's `contacts`). Belay keeps them in its
-- own storage on the phone; it never writes them into Android's Contacts. A `parent` one always
-- rings and is on the kid's emergency card.
CREATE TABLE contacts (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                         -- the server's ("c-…"), as the policy and call records name it
  name TEXT NOT NULL,                       -- the family's words (or the kid's, from a request a parent approved), at most 60 characters
  calls INTEGER NOT NULL DEFAULT 1 CHECK (calls IN (0, 1)),
  texts INTEGER NOT NULL DEFAULT 1 CHECK (texts IN (0, 1)),
  parent INTEGER NOT NULL DEFAULT 0 CHECK (parent IN (0, 1)),
  request_id TEXT,                          -- the kid's request a parent approved to add it, if one did
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, id)
) STRICT;

-- Each contact's numbers, at most 5, in the order a parent gave them. A number is one contact's.
CREATE TABLE contact_numbers (
  device_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  number TEXT NOT NULL,                     -- E.164
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 4),
  PRIMARY KEY (device_id, number),
  FOREIGN KEY (device_id, contact_id) REFERENCES contacts(device_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX contact_numbers_contact ON contact_numbers(device_id, contact_id, position);

-- Numbers a parent named for each phone: `private` ones Belay never records or reads (beyond 988
-- and emergency numbers, which it never does), at most 50; `blocked` ones Belay, as the phone app,
-- puts on Android's block list, at most 500. Never an emergency number or 988: the server refuses.
CREATE TABLE call_numbers (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('private', 'blocked')),
  number TEXT NOT NULL,                     -- E.164
  added_at INTEGER NOT NULL,
  added_by TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- the parent, or whose AI connection; NULL: the server's CLI
  client_name TEXT,                         -- an AI app that blocked it, through added_by's connection
  PRIMARY KEY (device_id, kind, number)
) STRICT;

-- What the phone sent about each call (POST /api/v1/calls), only while its rules record calls:
-- when, which way, how long, what happened, and the contact, or the number for a caller who isn't
-- one. Never what was said, and never a call with an emergency number, 988 or a private number.
-- Kept 90 days (a setting).
CREATE TABLE call_records (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                         -- the phone's UUID
  at INTEGER NOT NULL,                      -- the phone's clock
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  contact_id TEXT,                          -- the contact, as the phone named it (it may have been removed since)
  contact_name TEXT,                        -- that contact's name when the record arrived (the family's words)
  number TEXT,                              -- E.164, only for someone who isn't a contact; NULL: no caller id
  duration_s INTEGER NOT NULL CHECK (duration_s BETWEEN 0 AND 86400),
  outcome TEXT NOT NULL CHECK (outcome IN ('answered', 'missed', 'rejected', 'voicemail', 'not_placed')),
  reason TEXT CHECK (reason IN ('unknown', 'withheld', 'quiet', 'not_allowed')),
  received_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, id),
  CHECK (contact_id IS NULL OR number IS NULL)
) STRICT;
CREATE INDEX call_records_at ON call_records(device_id, at);
CREATE INDEX call_records_received ON call_records(device_id, received_at);
