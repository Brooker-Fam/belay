-- Belay server schema, version 3: the security review's fixes, and Phases 6 and 10 on the
-- server. Times are integers: milliseconds since the epoch, UTC.

-- A proposal can be out of date: what it was about changed after it was made (another pause, a
-- parent's own decision on the app), so approving it applies nothing. SQLite can't change a
-- CHECK constraint in place, so the table is made again; no other table refers to it.
CREATE TABLE proposals_v3 (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('allow_app', 'resume', 'lift_restriction', 'web_filter_off', 'new_apps_allow')),
  package TEXT,                             -- allow_app
  restriction TEXT,                         -- lift_restriction
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
INSERT INTO proposals_v3 (id, device_id, kind, package, restriction, reason, client_name, parent_id, created_at, status, decided_by, decided_at)
  SELECT id, device_id, kind, package, restriction, reason, client_name, parent_id, created_at, status, decided_by, decided_at FROM proposals;
DROP TABLE proposals;
ALTER TABLE proposals_v3 RENAME TO proposals;
CREATE INDEX proposals_status ON proposals(status, created_at);

-- When the pause in force was set or last changed, so a proposal to resume knows which pause
-- it meant. NULL for a pause from before this version.
ALTER TABLE policies ADD COLUMN pause_set_at INTEGER;
