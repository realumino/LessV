-- Node maintenance actions, and the geodata version a node reports.
--
-- WHY a table and not columns: an action is a request with a life cycle
-- (pending → ok/failed) that the node picks up on a heartbeat and answers
-- through its own result endpoint. One row per (node, action) is the whole
-- contract: a new request replaces the row, a report finishes it, and a
-- failed action stays visible until the admin retries.
--
-- WHY `target`: an Xray update names a release tag (or "latest", resolved by
-- the node itself). Geodata has no target today, so the column stays NULL.
--
-- WHY no foreign keys: the same convention as 0001-0009; deletion order is
-- explicit in src/db.ts.

ALTER TABLE nodes ADD COLUMN geodata_version TEXT;

CREATE TABLE IF NOT EXISTS node_actions (
    node_id      TEXT NOT NULL,
    action       TEXT NOT NULL,
    target       TEXT,
    state        TEXT NOT NULL DEFAULT 'pending',
    message      TEXT,
    requested_at INTEGER NOT NULL,
    finished_at  INTEGER,
    PRIMARY KEY (node_id, action)
);
