-- Belay server schema, version 10 (Phase 2): Play's allowed accounts (docs/platform-notes.md, A4).
-- Number 9 is network logging's (Phase 3), built alongside. Times are integers: milliseconds since
-- the epoch, UTC.

-- The parent-owned Google accounts (their email addresses) Google Play may use on the phone: the
-- policy's `play_accounts`, which the phone sets as Play's `allowed_accounts` managed
-- configuration. A parent sets them on the phone's page, with hardening; empty, the phone leaves
-- Play's configuration alone. A hand-over empties them.
ALTER TABLE policies ADD COLUMN play_accounts TEXT NOT NULL DEFAULT '[]';  -- JSON: email addresses
