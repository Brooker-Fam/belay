-- Belay server schema, version 15 (Phase 13, mobile data: docs/design/phase13-mobile-data.md).
-- Two parts, both off until a parent turns them on. Wi-Fi-only apps: apps the phone keeps off
-- mobile data (and every other metered network) as device owner. Mobile data use: how many bytes
-- each app used on mobile data each day, with the day's Wi-Fi total, while a parent measures it;
-- never which websites or networks, and never the apps the phone never blocks one by one (the
-- phone app, texting…: they're in one line with Android's own parts). Times are integers:
-- milliseconds since the epoch, UTC.

-- Each phone's measuring switch (the policy's `mobile_data.measure`). A phone without a row
-- doesn't measure. Turning it on or off is a parent's alone: never an AI app's, not even as a
-- proposal.
CREATE TABLE mobile_data_settings (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  measure INTEGER NOT NULL DEFAULT 0 CHECK (measure IN (0, 1)),
  measure_since INTEGER,                    -- when it was last turned on
  changed_at INTEGER NOT NULL,
  changed_by TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- NULL: the server's CLI
  dropped INTEGER NOT NULL DEFAULT 0,       -- days the phone sent while it was off: not kept
  dropped_at INTEGER                        -- the last time one was
) STRICT;

-- The Wi-Fi-only apps (the policy's `mobile_data.wifi_only`): the phone keeps each one off mobile
-- data. Adding one tightens: a parent, or an AI app a parent connected. Taking one off loosens: a
-- parent, or a parent approving an AI app's proposal. Never an app the phone never blocks.
CREATE TABLE wifi_only_apps (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  package TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  added_by TEXT NOT NULL CHECK (added_by IN ('parent', 'ai', 'server')),
  parent_id TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- the parent, or whose connection the AI app used
  client_name TEXT,                         -- the AI app, when one added it
  PRIMARY KEY (device_id, package)
) STRICT;

-- What the phone sent (POST /api/v1/mobile-data), one local day per row: a day sent again
-- replaces the stored one, apps and all. Kept 90 days by default (a setting), then deleted by the
-- hourly clean-up.
CREATE TABLE mobile_data_days (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                        -- "YYYY-MM-DD" in zone
  zone TEXT NOT NULL,                       -- IANA, as the phone sent it
  from_at INTEGER NOT NULL,                 -- counted from: the day's start, or when measuring turned on (the phone's clock)
  as_of INTEGER NOT NULL,                   -- counted up to (the phone's clock)
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  mobile_bytes INTEGER NOT NULL CHECK (mobile_bytes >= 0),    -- everything on mobile data, every line below included
  wifi_bytes INTEGER NOT NULL CHECK (wifi_bytes >= 0),        -- everything on Wi-Fi, all apps together
  android_bytes INTEGER NOT NULL CHECK (android_bytes >= 0),  -- Android's own parts, shared uids and the apps the phone never blocks
  removed_bytes INTEGER NOT NULL CHECK (removed_bytes >= 0),  -- apps removed since
  hotspot_bytes INTEGER NOT NULL CHECK (hotspot_bytes >= 0),  -- other devices, through this phone's hotspot
  received_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, day)
) STRICT;
CREATE INDEX mobile_data_days_day ON mobile_data_days(day);

-- Each app's bytes on mobile data that day, received and sent. A package name is its developer's
-- choice: untrusted.
CREATE TABLE mobile_data_apps (
  device_id TEXT NOT NULL,
  day TEXT NOT NULL,
  package TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 1),
  PRIMARY KEY (device_id, day, package),
  FOREIGN KEY (device_id, day) REFERENCES mobile_data_days(device_id, day) ON DELETE CASCADE
) STRICT;

-- AI apps' proposals gain mobile_data: a change to the Wi-Fi-only apps that takes one off (alone
-- or with others added). Measuring is never proposed: it's a parent's alone. Made again for its
-- CHECK constraint, with every kind before it; no other table refers to it.
CREATE TABLE proposals_v15 (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('allow_app', 'resume', 'lift_restriction', 'web_filter_off', 'new_apps_allow', 'screen_time', 'move_stage', 'calls', 'mobile_data')),
  package TEXT,                             -- allow_app
  restriction TEXT,                         -- lift_restriction
  payload TEXT,                             -- JSON: screen_time, calls and mobile_data, the change with what each part was; move_stage, the stage
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
INSERT INTO proposals_v15 (id, device_id, kind, package, restriction, payload, reason, client_name, parent_id, created_at, status, decided_by, decided_at, context, outdated_why)
  SELECT id, device_id, kind, package, restriction, payload, reason, client_name, parent_id, created_at, status, decided_by, decided_at, context, outdated_why
  FROM proposals ORDER BY rowid;
DROP TABLE proposals;
ALTER TABLE proposals_v15 RENAME TO proposals;
CREATE INDEX proposals_status ON proposals(status, created_at);
