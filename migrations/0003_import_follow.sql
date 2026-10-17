-- For importing years of Nightscout data and following a Nightscout server.

-- Predicted glucose curves: one row per curve (about 50 times fewer rows than
-- one per value; AAPS uploads a status with up to four curves every 5 minutes).
CREATE TABLE devicestatus_curves (
  devicestatus_identifier text NOT NULL REFERENCES devicestatus (identifier) ON DELETE CASCADE ON UPDATE CASCADE,
  source          text NOT NULL CHECK (source IN ('suggested', 'enacted')),
  curve           text NOT NULL,     -- IOB, COB, UAM, ZT
  "values"        double precision[] NOT NULL,
  PRIMARY KEY (devicestatus_identifier, source, curve)
);
INSERT INTO devicestatus_curves (devicestatus_identifier, source, curve, "values")
  SELECT devicestatus_identifier, source, curve, array_agg(value ORDER BY position)
    FROM devicestatus_predictions GROUP BY 1, 2, 3;
DROP TABLE devicestatus_predictions;
ALTER TABLE devicestatus_curves RENAME TO devicestatus_predictions;
ALTER TABLE devicestatus_predictions RENAME CONSTRAINT devicestatus_curves_pkey TO devicestatus_predictions_pkey;

-- Fields AAPS has been sending for years that had no column yet.
ALTER TABLE devicestatus
  ADD COLUMN uploader_type                 text,
  ADD COLUMN suggested_algorithm           text,
  ADD COLUMN suggested_running_dynamic_isf boolean,
  ADD COLUMN suggested_isf_mgdl_for_carbs  double precision,
  ADD COLUMN suggested_carbs_req_within    double precision,
  ADD COLUMN suggested_console_log         text[],
  ADD COLUMN suggested_console_error       text[],
  ADD COLUMN enacted_algorithm             text,
  ADD COLUMN enacted_running_dynamic_isf   boolean,
  ADD COLUMN enacted_isf_mgdl_for_carbs    double precision,
  ADD COLUMN enacted_carbs_req_within      double precision,
  ADD COLUMN enacted_console_log           text[],
  ADD COLUMN enacted_console_error         text[],
  ADD COLUMN enacted_smb                   double precision,
  ADD COLUMN enacted_requested_duration    double precision,
  ADD COLUMN enacted_requested_rate        double precision,
  ADD COLUMN enacted_requested_temp        text,
  ADD COLUMN enacted_requested_smb         double precision;

ALTER TABLE treatments
  ADD COLUMN original_extended_amount double precision,
  ADD COLUMN profile_plugin           text,
  -- Insulin of the bolus (icfg).
  ADD COLUMN insulin_label            text,
  ADD COLUMN insulin_end_time         bigint,   -- ms
  ADD COLUMN insulin_peak_time        bigint,   -- ms
  ADD COLUMN insulin_concentration    double precision,
  -- Nightscout careportal bolus wizard input (until 2022).
  ADD COLUMN boluscalc                jsonb;

-- Where following another Nightscout server has got to, per collection:
-- the source's srvModified of the newest document copied.
CREATE TABLE follow_state (
  collection    text PRIMARY KEY,
  last_modified bigint NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
