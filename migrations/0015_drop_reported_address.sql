-- The fleet view needs "when did this node last report", not "where from".
--
-- WHY drop the column instead of keeping it unwritten: a dead column invites a
-- reader, and the address it held was a self-report that said nothing about
-- reachability (`nodes.address` is the admin-set share-link domain).
ALTER TABLE nodes DROP COLUMN reported_address;
