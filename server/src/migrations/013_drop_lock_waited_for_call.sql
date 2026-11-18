-- Belay server schema, version 13 (Phase 3, the fifth security review, F2): migration 012's
-- `commands.waited_for_call` goes. Whether a lock_now's lock waited for a call told the parent
-- page, and AI apps with every category off, that the kid was on a call then, a 911 or 988 call
-- included. The phone now reports a lock_now when it has it, during a call too (its lock waits for
-- the call to end), and the device API has no such field, so nothing about a call is kept.
-- Dropping the column also clears any 1 a phone sent before.
ALTER TABLE commands DROP COLUMN waited_for_call;
