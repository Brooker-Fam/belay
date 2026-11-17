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

-- Only the first time new apps wait for a parent are the apps already on the phone allowed
-- ("grandfathered"); later, the parent chooses among those installed while new apps were
-- allowed. From the activity log for phones that had rules before this version.
ALTER TABLE policies ADD COLUMN ask_first_at INTEGER;  -- when new apps first waited for a parent
ALTER TABLE policies ADD COLUMN new_apps_at INTEGER;   -- when new_apps last changed
UPDATE policies SET ask_first_at = (
  SELECT MIN(a.at) FROM audit_log a WHERE a.device_id = policies.device_id
    AND (a.action = 'policy.protected' OR (a.action = 'policy.new_apps' AND json_extract(a.detail, '$.mode') = 'ask')));
UPDATE policies SET ask_first_at = changed_at WHERE ask_first_at IS NULL
  AND (new_apps = 'ask' OR EXISTS (SELECT 1 FROM app_decisions d WHERE d.device_id = policies.device_id AND d.decided_by = 'grandfathered'));
UPDATE policies SET new_apps_at = (
  SELECT MAX(a.at) FROM audit_log a WHERE a.device_id = policies.device_id
    AND a.action IN ('policy.new_apps', 'policy.protected', 'policy.unprotected'));
UPDATE policies SET new_apps_at = changed_at WHERE new_apps_at IS NULL AND ask_first_at IS NOT NULL;

-- A new request for an app that already has one waiting takes its place ('superseded'), so
-- the cap on waiting requests counts apps, not reinstalls. The table is made again for its
-- CHECK constraint; no other table refers to it.
CREATE TABLE requests_v3 (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  id TEXT NOT NULL,                         -- the phone's UUID
  kind TEXT NOT NULL CHECK (kind IN ('app')),
  package TEXT NOT NULL,
  label TEXT NOT NULL,                      -- from the app's developer: untrusted
  reason TEXT,                              -- the kid's own words: untrusted
  asked_at INTEGER NOT NULL,                -- the phone's clock
  received_at INTEGER NOT NULL,             -- the server's clock
  updated_at INTEGER NOT NULL,              -- when the reason last changed
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'talk', 'superseded')),
  note TEXT,                                -- the parent's answer, shown to the kid
  answered_by TEXT REFERENCES parents(id) ON DELETE SET NULL,
  answered_at INTEGER,
  superseded_by TEXT,                       -- for 'superseded': the newer request for the same app
  PRIMARY KEY (device_id, id)
) STRICT;
INSERT INTO requests_v3 (device_id, id, kind, package, label, reason, asked_at, received_at, updated_at, status, note, answered_by, answered_at)
  SELECT device_id, id, kind, package, label, reason, asked_at, received_at, updated_at, status, note, answered_by, answered_at FROM requests ORDER BY rowid;
DROP TABLE requests;
ALTER TABLE requests_v3 RENAME TO requests;
CREATE INDEX requests_received ON requests(device_id, received_at);
CREATE INDEX requests_status ON requests(status, received_at);
-- Of several requests waiting for one app, the newest stays.
UPDATE requests SET status = 'superseded', superseded_by = (
    SELECT n.id FROM requests n WHERE n.device_id = requests.device_id AND n.package = requests.package AND n.status = 'pending'
    ORDER BY n.received_at DESC, n.rowid DESC LIMIT 1)
  WHERE status = 'pending' AND EXISTS (
    SELECT 1 FROM requests n WHERE n.device_id = requests.device_id AND n.package = requests.package AND n.status = 'pending'
      AND (n.received_at > requests.received_at OR (n.received_at = requests.received_at AND n.rowid > requests.rowid)));
