-- AAPS loop settings that AAPS doesn't upload (docs/simulator-plan.md), as
-- entered on the simulate page: each value holds from valid_from until a
-- later row for the same setting. The simulator and the replay check use
-- them before values read from the loop's reasons and logs, and AAPS's
-- defaults last. `value` is a JSON number, boolean or null.
CREATE TABLE loop_settings (
  setting     text NOT NULL,
  value       jsonb NOT NULL,
  valid_from  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text,
  PRIMARY KEY (setting, valid_from)
);
