-- Prediction models (src/predict) are uploaded to the server instead of
-- shipped with the code. The newest row is the one in use; older rows stay
-- for reference.
CREATE TABLE prediction_models (
  id          bigserial PRIMARY KEY,
  version     text NOT NULL,
  model       jsonb NOT NULL,
  uploaded_by text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Access tokens that may upload models (and do nothing else).
ALTER TABLE subjects ADD COLUMN can_upload_model boolean NOT NULL DEFAULT false;
