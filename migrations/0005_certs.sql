-- Certificate subsystem tables.
--
-- WHY no foreign keys: migrations 0001-0004 in this project declare none, and
-- deletion order (domain -> runs -> challenges -> assignments) is handled
-- explicitly by src/cert/store/d1.ts. Consistency with the existing schema
-- outweighs the integrity a FK would add.

CREATE TABLE IF NOT EXISTS cert_domains (
    id               TEXT PRIMARY KEY,
    name             TEXT NOT NULL UNIQUE,   -- lowercase punycode; may start with "*."
    zone_id          TEXT NOT NULL,
    include_wildcard INTEGER NOT NULL DEFAULT 1,
    acme_profile     TEXT NOT NULL DEFAULT 'tlsserver', -- tlsserver | classic
    renew_before_days INTEGER,               -- NULL = actual lifetime / 3
    status           TEXT NOT NULL DEFAULT 'active',    -- active | paused | deleted
    last_error       TEXT,                   -- production only
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS certificates (
    id                 TEXT PRIMARY KEY,
    domain_id          TEXT NOT NULL,
    environment        TEXT NOT NULL,        -- production | staging
    serial             TEXT NOT NULL,
    fingerprint_sha256 TEXT NOT NULL,
    sans_json          TEXT NOT NULL,
    not_before         TEXT NOT NULL,
    not_after          TEXT NOT NULL,
    profile            TEXT NOT NULL,        -- profile echoed by CA (or requested)
    issued_at          TEXT NOT NULL,
    r2_prefix          TEXT NOT NULL,
    is_current         INTEGER NOT NULL DEFAULT 0,
    purged_at          TEXT,
    created_at         TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cert_current_env
    ON certificates(domain_id, environment) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_cert_domain_env
    ON certificates(domain_id, environment, created_at);

CREATE TABLE IF NOT EXISTS acme_accounts (
    environment   TEXT PRIMARY KEY,          -- staging | production
    directory_url TEXT NOT NULL,
    account_url   TEXT NOT NULL,
    private_key   TEXT NOT NULL,             -- v1: sealed PKCS#8 PEM
    public_jwk    TEXT NOT NULL,             -- JSON; needed to rebuild CryptoKeyPair
    thumbprint    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issue_runs (
    id          TEXT PRIMARY KEY,
    domain_id   TEXT NOT NULL,
    environment TEXT NOT NULL,
    trigger     TEXT NOT NULL,               -- renew | manual | test
    status      TEXT NOT NULL,               -- queued | running | succeeded | failed
    phase       TEXT,
    error       TEXT,                        -- LE/Cloudflare error verbatim
    workflow_id TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT,
    steps_json  TEXT,
    created_at  TEXT NOT NULL
);
-- One active run per domain, regardless of environment: _acme-challenge
-- TXT names collide across staging and production.
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_active
    ON issue_runs(domain_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_run_domain
    ON issue_runs(domain_id, created_at);
CREATE INDEX IF NOT EXISTS idx_run_workflow
    ON issue_runs(workflow_id);

CREATE TABLE IF NOT EXISTS challenge_records (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    zone_id     TEXT NOT NULL,
    cf_record_id TEXT NOT NULL,
    name        TEXT NOT NULL,
    value       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_challenge_run
    ON challenge_records(run_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_challenge_stale
    ON challenge_records(deleted_at, created_at);

CREATE TABLE IF NOT EXISTS node_cert_domains (
    node_id     TEXT NOT NULL,
    domain_id   TEXT NOT NULL,
    assigned_at INTEGER NOT NULL,
    PRIMARY KEY (node_id, domain_id)
);
