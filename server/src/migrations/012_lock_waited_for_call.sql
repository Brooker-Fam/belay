-- Belay server schema, version 12 (Phase 3, the fourth security review): a lock_now the phone
-- reported expired while its lock waited for a call that was still on (enforcement.commands'
-- `waited_for_call`), so the parent page and AI apps say a call was on until it expired, not that
-- the phone got it too late. 1 only on a result of 'expired'.
ALTER TABLE commands ADD COLUMN waited_for_call INTEGER NOT NULL DEFAULT 0 CHECK (waited_for_call IN (0, 1));
