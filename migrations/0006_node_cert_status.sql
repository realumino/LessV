-- Agent-reported nginx/certificate status columns on nodes.
-- NULL nginx_ok means "unknown" (no cert report yet).

ALTER TABLE nodes ADD COLUMN nginx_ok INTEGER;      -- NULL unknown, 0 failed, 1 ok
ALTER TABLE nodes ADD COLUMN nginx_error TEXT;
ALTER TABLE nodes ADD COLUMN cert_etag TEXT;
ALTER TABLE nodes ADD COLUMN cert_synced_at INTEGER; -- Unix seconds
