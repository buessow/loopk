-- API searches sort like Nightscout's MongoDB, with nulls lowest: ASC NULLS
-- FIRST, DESC NULLS LAST. A NULLS FIRST index serves both directions, so a
-- "newest N" search reads N index entries instead of sorting every row.
-- MAX(...) for the freshness monitor works with either null order.
DROP INDEX entries_date_idx;
DROP INDEX entries_type_date_idx;
CREATE INDEX entries_date_idx ON entries (date NULLS FIRST);
CREATE INDEX entries_type_date_idx ON entries (type, date NULLS FIRST);

DROP INDEX treatments_date_idx;
DROP INDEX treatments_created_at_idx;
DROP INDEX treatments_event_type_created_at_idx;
CREATE INDEX treatments_date_idx ON treatments (date NULLS FIRST);
CREATE INDEX treatments_created_at_idx ON treatments (created_at NULLS FIRST);
CREATE INDEX treatments_event_type_created_at_idx ON treatments (event_type, created_at NULLS FIRST);

-- devicestatus had no date index, so searches by date read the whole table.
DROP INDEX devicestatus_created_at_idx;
CREATE INDEX devicestatus_date_idx ON devicestatus (date NULLS FIRST);
CREATE INDEX devicestatus_created_at_idx ON devicestatus (created_at NULLS FIRST);

DROP INDEX profile_date_idx;
CREATE INDEX profile_date_idx ON profile (date NULLS FIRST);

DROP INDEX heartrate_date_idx;
DROP INDEX heartrate_created_at_idx;
CREATE INDEX heartrate_date_idx ON heartrate (date NULLS FIRST);
CREATE INDEX heartrate_created_at_idx ON heartrate (created_at NULLS FIRST);
