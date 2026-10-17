-- The Nightscout server this one follows, as an admin set it on the Access
-- page (FOLLOW_URL / FOLLOW_TOKEN apply only while there is no row). At most
-- one row. The token is an access token on that server, kept as entered: it
-- is needed again whenever the server's JWT expires.
CREATE TABLE follow_config (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  url         text NOT NULL,
  token       text NOT NULL,
  enabled     boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

-- Which server a cursor belongs to: following another server starts over.
-- NULL (cursors written by the MongoDB migration): the first server followed.
ALTER TABLE follow_state ADD COLUMN source_url text;
