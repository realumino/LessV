-- The node endpoint registry: plane-side identity for every inbound and
-- outbound the authored config declares.
--
-- WHY ids at all: everything the plane stores per endpoint — user access,
-- REALITY keys, link variants — must survive an operator renaming a tag in
-- the authored config. The registry row owns the identity (`id`), the config
-- owns the current name (`tag`), and rebinding the row to a new tag keeps
-- every reference intact. Legacy rows were created with `id = tag`, so the
-- data that already exists needs no rewrite.
--
-- WHY no foreign keys: the same convention as 0001-0007; deletion order is
-- explicit in src/db.ts.

CREATE TABLE IF NOT EXISTS node_inbounds (
    node_id    TEXT NOT NULL,
    id         TEXT NOT NULL,
    tag        TEXT NOT NULL,
    label      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (node_id, id)
);
-- One row per authored tag: the index is what makes the lazy sync from the
-- config idempotent under concurrent requests.
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_inbounds_tag
    ON node_inbounds(node_id, tag);

CREATE TABLE IF NOT EXISTS node_outbounds (
    node_id    TEXT NOT NULL,
    id         TEXT NOT NULL,
    tag        TEXT NOT NULL,
    label      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (node_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_node_outbounds_tag
    ON node_outbounds(node_id, tag);

-- Link variants: the former link_profiles, now attached to an inbound id
-- instead of a tag. The unlabeled default view of an inbound is the inbound
-- row itself, so only extra client-side views (CDN fronting, another port)
-- live here.
ALTER TABLE link_profiles RENAME TO inbound_links;
ALTER TABLE inbound_links RENAME COLUMN inbound_tag TO inbound_id;
CREATE INDEX IF NOT EXISTS idx_inbound_links_inbound
    ON inbound_links(node_id, inbound_id);

-- REALITY keys follow the inbound identity, not its current tag: a rebind
-- must keep the key, or every client using that inbound would be locked out.
ALTER TABLE reality_keys RENAME COLUMN inbound_tag TO inbound_id;
