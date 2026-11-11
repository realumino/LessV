-- Which ACME environment's current certificates the plane delivers to a node.
-- The plane keeps a current staging and a current production certificate per
-- domain; this column selects which of the two `GET /api/node/certs` serves,
-- so a node can be tested against Let's Encrypt staging without an assignment
-- change. Existing nodes stay on production.

ALTER TABLE nodes ADD COLUMN cert_environment TEXT NOT NULL DEFAULT 'production'; -- production | staging
