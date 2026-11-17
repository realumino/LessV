-- Admin identities: more than one principal may hold the panel.
--
-- WHY a table and not more env secrets: adding an operator today is a
-- deploy (rotate ADMIN_KEY, tell everyone, update every script). A row per
-- key makes minting and revoking runtime actions — the panel or one CLI
-- command — while `ADMIN_KEY` stays accepted as break-glass for this
-- release only (the release after this one removes it, a contract step
-- with no rollback).
--
-- WHY the same token rules as node tokens: a 32-byte random token,
-- SHA-256-at-rest, constant-time compare. The plaintext is shown once at
-- mint time and never stored.
--
-- WHY `disabled_at` instead of DELETE: a disabled key is evidence — who
-- had access and when it was taken away — and the middleware answers a
-- disabled key with the same 401 body as an unknown one, so nothing leaks.
--
-- WHY no foreign keys: the same convention as 0001-0016; this table has
-- no references.

CREATE TABLE IF NOT EXISTS admin_keys (
    id          TEXT PRIMARY KEY,
    label       TEXT NOT NULL,
    key_hash    TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    disabled_at INTEGER
);
