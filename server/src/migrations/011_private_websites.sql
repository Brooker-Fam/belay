-- Belay server schema, version 11 (Phase 3, network logging): the family's private websites.
-- Websites Belay never keeps a lookup of on a phone, or of a name under one, like 988's: a
-- helpline's or a counselor's site the kid may use. Each is a registrable domain ("example.org"),
-- the same lowercase hostname a network entry's domain is; the policy's
-- `network_log.private_domains`. A parent's alone: never an AI app's, not even as a proposal, and
-- an AI app never sees them. Times are integers: milliseconds since the epoch, UTC.
CREATE TABLE network_private_domains (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,                     -- registrable, lowercase, in Punycode
  added_at INTEGER NOT NULL,
  added_by TEXT REFERENCES parents(id) ON DELETE SET NULL,  -- NULL: the server's CLI
  PRIMARY KEY (device_id, domain)
) STRICT;
