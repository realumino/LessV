-- One ACME profile, no operator choice.
--
-- `classic` was a second lifetime for the same deliverable (90 days instead
-- of 45) and nothing in the node delivery path needed it. The plane now always
-- requests `tlsserver`; this normalizes rows created while the choice existed
-- so the stored value matches what every future order asks for.

UPDATE cert_domains SET acme_profile = 'tlsserver' WHERE acme_profile <> 'tlsserver';
