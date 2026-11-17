-- WHAT: record the protocol each server declared on its latest contact.
--
-- WHY a column and not a log line: the fleet view must explain a skew ("this
-- server is on an older protocol"), and the accepted window
-- [SUPPORTED_PROTOCOL_MIN, PROTOCOL_VERSION] in src/routers/node.ts makes
-- older-but-supported servers legal. NULL until a node enrolls or
-- heartbeats; the reader treats a missing column as NULL, so a deploy whose
-- migration lagged is harmless.
ALTER TABLE nodes ADD COLUMN protocol INTEGER;
