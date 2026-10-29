-- The "AI Test" profile an agent edits through the MCP tools to simulate
-- with (src/oref/testprofile.js). It lives only here, outside the profile
-- collection, so AAPS never receives it; on the Profiles page an admin can
-- copy it into a profile of the profile store. `profile` holds { dia, units,
-- timezone, basal, ic, isf, targetLow, targetHigh }, schedules as
-- [[seconds from midnight, value]] at 100%.
CREATE TABLE test_profiles (
  name        text PRIMARY KEY,
  profile     jsonb NOT NULL,
  based_on    text,
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
