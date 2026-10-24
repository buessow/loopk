-- The newest loop configuration before a time (Claude reviews, the MCP
-- server): AAPS sends it with about one device status in forty, so finding
-- it without an index reads the whole table.
CREATE INDEX devicestatus_configuration_date_idx ON devicestatus (date) WHERE configuration_aps IS NOT NULL;
