-- Certificate artifacts move from R2 into D1: PEM text is a few kilobytes,
-- far below D1's row limit, and one store is simpler than two.
--
-- WHY the key is written before the rest: issuance walks key → order → cert,
-- and a workflow retry must find the key it already generated. NULL PEM
-- columns therefore mean "issuance not finished", not corrupt data.
--
-- WHY there is no meta_json column: the R2 `meta.json` object duplicated facts
-- that are already columns of `certificates`, and nothing ever read it back
-- (the admin download endpoint offers cert/chain/fullchain/key only).
CREATE TABLE IF NOT EXISTS certificate_artifacts (
    certificate_id TEXT PRIMARY KEY,   -- = certificates.id, or the workflow run id before that row exists
    private_key    TEXT NOT NULL,      -- v1:<base64(iv||ct+tag)>, sealed with KEY_SECRET
    cert_pem       TEXT,
    chain_pem      TEXT,
    fullchain_pem  TEXT,
    updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_updated ON certificate_artifacts(updated_at);

-- WHY drop instead of keeping a dead column: nothing may read an R2 path after
-- this release, and a kept column would keep the two-store model alive in the
-- code that writes it. 0005 stays untouched (migrations are append-only).
ALTER TABLE certificates DROP COLUMN r2_prefix;
