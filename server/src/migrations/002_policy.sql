-- Belay server schema, version 2 (Phase 2): the rules each phone enforces, the kid's
-- requests, and what AI apps propose. Times are integers: milliseconds since the epoch, UTC.

-- The rules for one phone (docs/protocol.md, "Policy"). A phone without a row gets version
-- 0, which enforces nothing (Phase 1).
CREATE TABLE policies (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,                 -- increases with every change the phone would see
  changed_at INTEGER NOT NULL,              -- when the version last increased
  protected_at INTEGER,                     -- when a parent turned protection on; NULL: off
  new_apps TEXT NOT NULL DEFAULT 'allow' CHECK (new_apps IN ('allow', 'ask')),
  paused INTEGER NOT NULL DEFAULT 0,
  pause_until INTEGER,                      -- NULL while paused: until a parent resumes it
  pause_note TEXT,                          -- shown to the kid
  restrictions TEXT NOT NULL DEFAULT '{}',  -- JSON: {"safe_boot": true, ...}; a missing one is off
  private_dns TEXT,                         -- a host, like family-filter-dns.cleanbrowsing.org
  chrome TEXT,                              -- JSON: Chrome's managed settings; NULL sets none
  hide_browsers INTEGER NOT NULL DEFAULT 0,
  maintenance_until INTEGER,                -- the debugging lock is lifted until then
  frp_accounts TEXT NOT NULL DEFAULT '[]',  -- JSON: Google account ids for factory reset protection
  support_message TEXT                      -- the parent's words on blocked-app screens
) STRICT;

-- Every decision about an app, kept: the latest one per app is the rule, and the rest say
-- why it changed. 'undecided' clears a decision.
CREATE TABLE app_decisions (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  package TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('allowed', 'blocked', 'undecided')),
  decided_by TEXT NOT NULL CHECK (decided_by IN ('parent', 'ai', 'grandfathered', 'server')),
  parent_id TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- the parent, or whose AI connection
  client_name TEXT,                         -- for 'ai': the connected app, e.g. 'Claude'
  proposal_id TEXT,                         -- a parent approved this AI proposal
  decided_at INTEGER NOT NULL,
  note TEXT
) STRICT;
CREATE INDEX app_decisions_app ON app_decisions(device_id, package, id);

-- What the kid asks for, from Belay's screen on the phone.
CREATE TABLE requests (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                         -- the phone's UUID
  kind TEXT NOT NULL CHECK (kind IN ('app')),
  package TEXT NOT NULL,
  label TEXT NOT NULL,                      -- from the app's developer: untrusted
  reason TEXT,                              -- the kid's own words: untrusted
  asked_at INTEGER NOT NULL,                -- the phone's clock
  received_at INTEGER NOT NULL,             -- the server's clock
  updated_at INTEGER NOT NULL,              -- when the reason last changed
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'talk')),
  note TEXT,                                -- the parent's answer, shown to the kid
  answered_by TEXT REFERENCES parents(id) ON DELETE SET NULL,
  answered_at INTEGER,
  PRIMARY KEY (device_id, id)
) STRICT;
CREATE INDEX requests_received ON requests(device_id, received_at);
CREATE INDEX requests_status ON requests(status, received_at);

-- What AI apps proposed that would loosen a rule. Nothing changes until a parent approves.
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('allow_app', 'resume', 'lift_restriction', 'web_filter_off', 'new_apps_allow')),
  package TEXT,                             -- allow_app
  restriction TEXT,                         -- lift_restriction
  reason TEXT NOT NULL,                     -- the AI app's words
  client_name TEXT NOT NULL,                -- which connected app
  parent_id TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- whose connection
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by TEXT REFERENCES parents(id) ON DELETE SET NULL,
  decided_at INTEGER
) STRICT;
CREATE INDEX proposals_status ON proposals(status, created_at);

-- Browsers a parent turned notifications on in (Web Push, RFC 8030). Notices are end-to-end
-- encrypted to the browser (RFC 8291): the push service can't read them.
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,            -- at a known push service; a capability URL, never logged
  p256dh TEXT NOT NULL,                     -- the browser's public key, base64url
  auth TEXT NOT NULL,                       -- the browser's auth secret, base64url
  name TEXT NOT NULL,                       -- "Safari on iPhone", for Settings
  created_at INTEGER NOT NULL,
  last_sent_at INTEGER
) STRICT;
CREATE INDEX push_subscriptions_parent ON push_subscriptions(parent_id);

-- The policy long-poll: which version the phone last said it has, and when it asked.
ALTER TABLE devices ADD COLUMN policy_have INTEGER;
ALTER TABLE devices ADD COLUMN policy_asked_at INTEGER;
