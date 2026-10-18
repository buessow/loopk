-- loopk-monitor reads MAX(created_at) from heartrate every ten seconds; like
-- the other monitored collections, answer it from an index, not a table scan.
CREATE INDEX heartrate_created_at_idx ON heartrate (created_at);
