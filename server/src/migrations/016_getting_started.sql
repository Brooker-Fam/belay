-- Belay server schema, version 16: the Phones page's Getting started card (family/start.ts). Each
-- step's tick comes from the server's own state, never a stored one; the one thing kept is a
-- parent's own choice to hide the card, which only that parent's Phones page follows. Times are
-- integers: milliseconds since the epoch, UTC.
ALTER TABLE parents ADD COLUMN start_hidden_at INTEGER;  -- when this parent hid Getting started; NULL: it shows until its essential steps are done
