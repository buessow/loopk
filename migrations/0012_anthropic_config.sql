-- The Anthropic API key for Claude's reviews of the loop, as an admin set it
-- on the Access page (ANTHROPIC_API_KEY applies only while there is no row).
-- At most one row. The key is kept as entered: every review needs it.
CREATE TABLE anthropic_config (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  api_key     text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
