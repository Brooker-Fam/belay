-- Belay server schema, version 8 (Phase 11): off belay (docs/design/phase11-off-belay.md). Every
-- family's stage list ends with Off belay, and a parent hands a phone over to the kid. Times are
-- integers: milliseconds since the epoch, UTC.

-- Off belay, the family's last stage: it blocks nothing (no limits or schedules), and the family
-- writes when it comes (its `how`), which the kid's phone shows from the first day. It's always
-- last, keeps its name and can't be deleted (family/offbelay.ts). A stage the family already
-- called "Off belay" keeps its rules under a new name.
ALTER TABLE stages ADD COLUMN off_belay INTEGER NOT NULL DEFAULT 0 CHECK (off_belay IN (0, 1));
CREATE UNIQUE INDEX stages_off_belay ON stages(off_belay) WHERE off_belay = 1;
UPDATE stages SET name = name || ' (before Off belay)' WHERE name = 'Off belay' COLLATE NOCASE;
INSERT INTO stages (id, number, name, how, rules, created_at, updated_at, updated_by, off_belay)
  SELECT 'off-belay', COALESCE(MAX(number), 0) + 1, 'Off belay', NULL,
    '{"limits":[],"schedules":[],"exempt":[],"if_unmeasured":"pause_limited","self_serve":null,"warn_before":5}',
    CAST(strftime('%s', 'now') AS INTEGER) * 1000, CAST(strftime('%s', 'now') AS INTEGER) * 1000, NULL, 1
  FROM stages;

-- A parent handing a phone over (the policy's `handover`): the server lifted factory reset,
-- debugging and the accounts lock and emptied reset protection as it was recorded, and the phone
-- shows the kid what to back up before a reset from Settings. A parent's action, or the server's
-- CLI; never an AI app's, not even as a proposal. Cancelling it deletes the row.
CREATE TABLE handovers (
  device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,                      -- when it was handed over (the policy's handover.at)
  by_parent TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- NULL: the server's CLI
  version INTEGER NOT NULL                  -- the rules version that carried it to the phone
) STRICT;
