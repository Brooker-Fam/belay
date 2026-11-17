-- Belay server schema, version 9 (Phase 3, the last part: network logging, docs/design/phase3-screen-time.md).
-- Which websites and online services each app on the phone looks up, per day, while a parent has
-- it on: the phone reduces Android's DNS lookups to counts (an app, a domain, how many times) and
-- sends nothing else. Never the never-blocked apps' lookups (the phone app, texting…), and never
-- 988's websites. Times are integers: milliseconds since the epoch, UTC.

-- Each phone's network logging switch (the policy's `network_log`). A phone without a row has it
-- off. Turning it on or off is a parent's alone: never an AI app's, not even as a proposal.
CREATE TABLE network_settings (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  enabled_at INTEGER,                       -- when it was last turned on
  changed_at INTEGER NOT NULL,
  changed_by TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- NULL: the server's CLI
  dropped INTEGER NOT NULL DEFAULT 0,       -- days the phone sent while it was off: not kept
  dropped_at INTEGER                        -- the last time one was
) STRICT;

-- What the phone sent, one local day per row (POST /api/v1/network): a day sent again replaces
-- the stored one. Kept 30 days by default (a setting), then deleted by the hourly clean-up.
CREATE TABLE network_days (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  day TEXT NOT NULL,                        -- "YYYY-MM-DD" in zone
  zone TEXT NOT NULL,                       -- IANA, as the phone sent it
  as_of INTEGER NOT NULL,                   -- the newest lookup counted (the phone's clock)
  dropped INTEGER NOT NULL CHECK (dropped >= 0),  -- entries the phone cut to stay under 5000 that day
  received_at INTEGER NOT NULL,
  PRIMARY KEY (device_id, day)
) STRICT;
CREATE INDEX network_days_day ON network_days(day);

-- How many times each app looked up each domain that day. A domain is a lowercase hostname, the
-- app's developer's choice: untrusted.
CREATE TABLE network_lookups (
  device_id TEXT NOT NULL,
  day TEXT NOT NULL,
  package TEXT NOT NULL,
  domain TEXT NOT NULL,
  lookups INTEGER NOT NULL CHECK (lookups >= 1),
  PRIMARY KEY (device_id, day, package, domain),
  FOREIGN KEY (device_id, day) REFERENCES network_days(device_id, day) ON DELETE CASCADE
) STRICT;
