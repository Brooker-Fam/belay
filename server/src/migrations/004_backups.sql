-- Belay server schema, version 4 (Phase 6): the server's own backups, the checks that prove
-- they restore, and what the server measures about itself. Times are integers: milliseconds
-- since the epoch, UTC.

-- Every backup the server made or tried to make: the daily job's (it keeps the newest 14
-- files in <data dir>/backups) and the backup command's. A failure is a row too.
CREATE TABLE backups (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('daily', 'manual')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  file TEXT NOT NULL,                       -- daily: its name in <data dir>/backups; manual: the path given
  bytes INTEGER,                            -- the file's size, when it worked
  db_bytes INTEGER,                         -- the database's size at the time
  encrypted INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL,
  error TEXT                                -- why it failed, in one line
) STRICT;
CREATE INDEX backups_kind ON backups(kind, started_at);
CREATE INDEX backups_ok ON backups(ok, started_at);

-- What proves a backup restores: verify-backup's results, and the restore drills parents did.
CREATE TABLE backup_checks (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('verify', 'drill')),
  at INTEGER NOT NULL,
  file TEXT,                                -- verify: the backup's file name
  ok INTEGER NOT NULL,
  detail TEXT,                              -- JSON: verify's report (schema, counts), or what failed
  parent_id TEXT REFERENCES parents(id) ON DELETE SET NULL  -- drill: who did it
) STRICT;
CREATE INDEX backup_checks_kind ON backup_checks(kind, at);

-- The database's size about once an hour, for the last 8 days: to tell when it grows fast.
CREATE TABLE db_sizes (
  at INTEGER PRIMARY KEY,
  bytes INTEGER NOT NULL
) STRICT;
