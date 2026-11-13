-- One literal name per (inbound view, exit) combination, overriding the
-- link-name template.
--
-- WHY a row per combination and not per variant: a variant's label names the
-- client-side view, while the combination is what a user sees in their client
-- (one URI per exit). `link_id = ''` is the inbound's default view, which has
-- no inbound_links row.
--
-- WHY cosmetic only: nothing here enters the rendered runtime config, so a
-- rename changes generated links and needs no node sync. Rows are also kept
-- when their variant evaporates (the registry's own convention): an orphan is
-- invisible until the same id comes back.
CREATE TABLE IF NOT EXISTS link_names (
    node_id     TEXT NOT NULL,
    inbound_id  TEXT NOT NULL,
    link_id     TEXT NOT NULL DEFAULT '',
    outbound_id TEXT NOT NULL,
    label       TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (node_id, inbound_id, link_id, outbound_id)
);
