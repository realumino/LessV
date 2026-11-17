-- The certificate subsystem's third-party credential, managed at runtime.
--
-- WHY a sealed row and not the CF_DNS_API_TOKEN secret: rotating the token
-- today is a deploy (`wrangler secret put`); a sealed row makes it a panel
-- action — paste, verify against `GET /zones`, store, activate. The token
-- is sealed with KEY_SECRET like every other stored credential, so a
-- database dump yields no live token.
--
-- WHY `active` and not a pointer: exactly one row is in force, and the
-- service enforces it — activate clears the others first. Until one row is
-- active, the reader falls back to the `CF_DNS_API_TOKEN` binding for one
-- release; the release after this one removes that fallback, making the
-- panel the only place a DNS token exists.
--
-- WHY no foreign keys: the same convention as 0001-0017; this table has
-- no references.

CREATE TABLE IF NOT EXISTS dns_credentials (
    id           TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    sealed_token TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    active       INTEGER NOT NULL DEFAULT 0
);
