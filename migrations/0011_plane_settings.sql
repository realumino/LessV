-- The plane's naming knobs, one row.
--
-- WHY a singleton row and not a key/value table: the set is closed and typed;
-- a new knob is a column (and a migration), which keeps every reader honest
-- about what exists and what it means.
--
-- WHY no seed row: the default template lives in src/services/labels.ts, and
-- a missing row means "the code default". Seeding would let the stored copy
-- and the code copy drift, with the stored one silently winning.
CREATE TABLE IF NOT EXISTS plane_settings (
    id                 INTEGER PRIMARY KEY CHECK (id = 1),
    link_name_template TEXT NOT NULL,
    updated_at         INTEGER NOT NULL
);
