-- Glucose predictions recorded when a reading arrives (src/predict/recorder.js),
-- so the chart can show what was predicted for each moment.
CREATE TABLE glucose_predictions (
  made_at  timestamptz NOT NULL, -- the newest reading the prediction used
  minutes  smallint NOT NULL,    -- how far ahead
  date     timestamptz NOT NULL, -- made_at + minutes: the time predicted for
  sgv      real NOT NULL,        -- mg/dL, the mean
  low      real,                 -- mg/dL, 10th percentile
  high     real,                 -- mg/dL, 90th percentile
  model_id bigint NOT NULL REFERENCES prediction_models (id) ON DELETE CASCADE,
  PRIMARY KEY (made_at, minutes)
);

CREATE INDEX glucose_predictions_date ON glucose_predictions (date);
