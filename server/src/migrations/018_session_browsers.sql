-- Belay server schema, version 18: the second bypass audit's B1, a parent's password used from the
-- kid's own phone. Each parent's session keeps the kind of browser it was signed in on ("Chrome on
-- Android", from its User-Agent: what the browser says it is, never the User-Agent itself), so
-- Settings can list a parent's signed-in browsers, each with its own Sign out, and every sign-in's
-- notice and activity line can say what it was on. Never the client's address (docs/privacy.md).
--
-- `id` names a session on the parent's own Settings page, for its Sign out: the primary key is
-- the cookie's hash, which no page shows. A session from before this gets an id now, and no
-- browser (NULL: Settings says it's from before Belay noted which).
ALTER TABLE sessions ADD COLUMN id TEXT;
ALTER TABLE sessions ADD COLUMN browser TEXT;  -- "Chrome on Android"; NULL for a session from before version 18
UPDATE sessions SET id = lower(hex(randomblob(16))) WHERE id IS NULL;
CREATE UNIQUE INDEX sessions_id ON sessions(id);
