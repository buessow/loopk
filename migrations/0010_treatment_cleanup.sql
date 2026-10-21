-- Duplicate treatments moved out, and the insulin each treatment delivered.
--
-- Duplicates: AAPS has uploaded some doses twice, under another identifier.
-- In 2019-2020 every SMB also came from the pump-history sync as a
-- "Correction Bolus" (about 19,000), and re-syncs of the pump history
-- (2021-11, 2023-03, 2024-12, 2025-01, 2025-07) uploaded weeks of boluses
-- again as "Meal Bolus". A treatment is a duplicate when another valid one
-- within 60 seconds carries every amount it carries (bolus insulin within
-- 0.011 U, carbs within 0.5 g; real SMBs are at least 3 minutes apart). Of
-- two copies of each other, the one marked SMB stays, else the one stored
-- first. Duplicates move to removed_treatments, with the identifier of the
-- treatment they duplicate; API clients don't see them disappear, so AAPS
-- keeps its own records. The server moves new duplicates there as they are
-- stored (src/db/collection.js). To run the cleanup again by hand:
--
--   SELECT count(*) FROM remove_duplicate_treatments('-infinity', 'infinity');
--
-- To put one back: INSERT INTO treatments SELECT <the treatments columns>
-- FROM removed_treatments WHERE identifier = '...', then delete it there.
-- removed_treatments has the columns of treatments, in the same order, then
-- its own: a migration that adds a column to treatments adds it to
-- removed_treatments too (before duplicate_of), or the functions below break.
--
-- delivered_insulin (U), kept up to date by triggers and not part of the API
-- documents (Nightscout clients add up `insulin` on every treatment, so basal
-- there would count as a bolus):
--   - boluses and SMBs: insulin (0 for priming);
--   - temp basals: the absolute rate over the time the temp basal ran: until
--     its duration or the next temp basal, whichever comes first (0 for a
--     cancel; NULL for a percent-only one, which needs the profile);
--   - extended boluses (Combo Bolus): the entered insulin, or 0 when a
--     FAKE_EXTENDED temp basal emulates it and so delivers it;
--   - other treatments: 0.
-- The profile basal between temp basals is no treatment and is not counted.

ALTER TABLE treatments ADD COLUMN delivered_insulin double precision DEFAULT 0;

CREATE INDEX treatments_temp_basal_date_idx ON treatments (date) WHERE event_type = 'Temp Basal';
CREATE INDEX treatments_extended_emulated_idx ON treatments ((extended_emulated->>'identifier'))
  WHERE type = 'FAKE_EXTENDED';

-- --------------------------------------------------------------- delivered insulin

CREATE FUNCTION temp_basal_insulin(t treatments) RETURNS double precision
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN NOT coalesce(coalesce(t.duration_in_milliseconds / 60000.0::float8, t.duration) > 0, false) THEN 0
    WHEN coalesce(t.absolute, t.rate) IS NULL THEN NULL
    ELSE greatest(coalesce(t.absolute, t.rate), 0) / 60 * least(
      coalesce(t.duration_in_milliseconds / 60000.0::float8, t.duration),
      coalesce(extract(epoch FROM (
        SELECT n.date FROM treatments n
         WHERE n.event_type = 'Temp Basal' AND n.date > t.date AND n.is_valid IS DISTINCT FROM false
         ORDER BY n.date LIMIT 1) - t.date)::float8 / 60, 'infinity'))
  END
$$;

CREATE FUNCTION treatment_delivered_insulin(t treatments) RETURNS double precision
LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN t.event_type = 'Temp Basal' THEN temp_basal_insulin(t)
    WHEN t.event_type = 'Combo Bolus' THEN
      CASE WHEN coalesce(t.is_emulating_temp_basal, false) OR EXISTS (
             SELECT 1 FROM treatments f
              WHERE f.type = 'FAKE_EXTENDED' AND f.extended_emulated->>'identifier' = t.identifier)
           THEN 0 ELSE greatest(coalesce(t.entered_insulin, 0), 0) END
    WHEN coalesce(t.type, '') IN ('PRIMING', 'FAKE_EXTENDED') THEN 0
    ELSE greatest(coalesce(t.insulin, 0), 0)
  END
$$;

UPDATE treatments t SET delivered_insulin = treatment_delivered_insulin(t)
 WHERE t.insulin > 0 OR t.event_type IN ('Temp Basal', 'Combo Bolus');

CREATE FUNCTION set_delivered_insulin() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.delivered_insulin := treatment_delivered_insulin(NEW);
  RETURN NEW;
END
$$;

-- A temp basal ends where the next one begins, and a FAKE_EXTENDED temp
-- basal delivers the extended bolus it emulates: when one changes, so does
-- the insulin of the temp basal before it and of that extended bolus.
CREATE FUNCTION refresh_related_delivered_insulin() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r treatments;
BEGIN
  IF pg_trigger_depth() > 1 THEN RETURN NULL; END IF;
  FOREACH r IN ARRAY CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW] WHEN 'DELETE' THEN ARRAY[OLD] ELSE ARRAY[OLD, NEW] END LOOP
    IF r.event_type = 'Temp Basal' THEN
      UPDATE treatments p SET delivered_insulin = treatment_delivered_insulin(p)
       WHERE p.identifier = (SELECT identifier FROM treatments
                              WHERE event_type = 'Temp Basal' AND date < r.date AND is_valid IS DISTINCT FROM false
                              ORDER BY date DESC LIMIT 1);
    END IF;
    IF r.type = 'FAKE_EXTENDED' AND r.extended_emulated->>'identifier' IS NOT NULL THEN
      UPDATE treatments c SET delivered_insulin = treatment_delivered_insulin(c)
       WHERE c.identifier = r.extended_emulated->>'identifier';
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;

CREATE TRIGGER treatments_delivered_insulin BEFORE INSERT OR UPDATE ON treatments
  FOR EACH ROW EXECUTE FUNCTION set_delivered_insulin();
CREATE TRIGGER treatments_related_delivered_insulin AFTER INSERT OR UPDATE OR DELETE ON treatments
  FOR EACH ROW EXECUTE FUNCTION refresh_related_delivered_insulin();

-- --------------------------------------------------------------- duplicates

CREATE TABLE removed_treatments (LIKE treatments INCLUDING DEFAULTS);
ALTER TABLE removed_treatments
  ADD COLUMN duplicate_of text NOT NULL,  -- the treatment it duplicates (may itself be removed later)
  ADD COLUMN removed_at timestamptz NOT NULL DEFAULT now(),
  ADD PRIMARY KEY (identifier);
CREATE INDEX removed_treatments_date_idx ON removed_treatments (date);
CREATE INDEX removed_treatments_duplicate_of_idx ON removed_treatments (duplicate_of);

-- Bolus insulin as the models count it (not priming, temp basals or extended boluses).
CREATE FUNCTION treatment_bolus_insulin(t treatments) RETURNS double precision
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN t.insulin > 0 AND coalesce(t.type, '') NOT IN ('PRIMING', 'FAKE_EXTENDED')
                   AND coalesce(t.event_type, '') NOT IN ('Combo Bolus', 'Temp Basal')
              THEN t.insulin ELSE 0 END
$$;

-- Moves the duplicates dated from_date..to_date to removed_treatments and
-- returns their identifiers.
CREATE FUNCTION remove_duplicate_treatments(from_date timestamptz, to_date timestamptz) RETURNS SETOF text
LANGUAGE sql AS $$
  WITH pairs AS (
    SELECT c.identifier, k.identifier AS kept
      FROM (SELECT t.identifier, t.date, treatment_bolus_insulin(t) AS u, coalesce(t.carbs, 0) AS g,
                   coalesce(t.type = 'SMB' OR t.is_smb, false) AS smb, t.srv_created
              FROM treatments t
             WHERE t.date BETWEEN from_date AND to_date AND t.is_valid IS DISTINCT FROM false
               AND (treatment_bolus_insulin(t) > 0 OR t.carbs > 0)
               AND NOT EXISTS (SELECT 1 FROM treatment_profiles p WHERE p.treatment_identifier = t.identifier)) c
      -- The treatment to keep in its place, if any: within 60 seconds, ...
      CROSS JOIN LATERAL (
        SELECT e.identifier
          FROM (SELECT t.identifier, treatment_bolus_insulin(t) AS u, coalesce(t.carbs, 0) AS g,
                       coalesce(t.type = 'SMB' OR t.is_smb, false) AS smb, t.srv_created
                  FROM treatments t
                 WHERE t.date BETWEEN c.date - interval '60 seconds' AND c.date + interval '60 seconds'
                   AND t.identifier <> c.identifier AND t.is_valid IS DISTINCT FROM false
                   AND NOT EXISTS (SELECT 1 FROM treatment_profiles p WHERE p.treatment_identifier = t.identifier)) e
         -- ... carrying everything c carries ...
         WHERE (c.u = 0 OR abs(e.u - c.u) < 0.011) AND (c.g = 0 OR abs(e.g - c.g) < 0.5)
           -- ... and if c carries everything e does too, e is the one to keep.
           AND NOT ((e.u = 0 OR abs(c.u - e.u) < 0.011) AND (e.g = 0 OR abs(c.g - e.g) < 0.5)
                    AND (c.smb > e.smb OR (c.smb = e.smb AND (c.srv_created, c.identifier) < (e.srv_created, e.identifier))))
         ORDER BY e.smb DESC, e.srv_created, e.identifier
         LIMIT 1) k
  ),
  moved AS (
    INSERT INTO removed_treatments
    SELECT t.*, p.kept, now() FROM treatments t JOIN pairs p USING (identifier)
    ON CONFLICT (identifier) DO UPDATE SET duplicate_of = EXCLUDED.duplicate_of, removed_at = EXCLUDED.removed_at
  )
  DELETE FROM treatments WHERE identifier IN (SELECT identifier FROM pairs) RETURNING identifier
$$;

SELECT count(*) AS removed_duplicates FROM remove_duplicate_treatments('-infinity', 'infinity');
