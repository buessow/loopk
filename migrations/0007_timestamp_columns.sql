-- date, srv_created and srv_modified as timestamptz instead of epoch
-- milliseconds. Documents keep these fields as milliseconds; src/db/schema.js
-- converts (type `ms`).
--
-- A date that a JavaScript Date cannot hold (before year 1, after
-- 8.64e15 ms) moves to `extra`, where the application keeps such values too.
-- srv_created and srv_modified are set by the server and always in range.
-- The indexes on these columns are rebuilt with their definitions unchanged.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['entries', 'treatments', 'devicestatus', 'profile', 'food', 'heartrate', 'settings'] LOOP
    EXECUTE format(
      $sql$UPDATE %I SET extra = coalesce(extra, '{}') || jsonb_build_object('date', date), date = NULL
           WHERE date NOT BETWEEN -62135596800000 AND 8640000000000000$sql$, t);
    -- Exact for integer milliseconds, unlike to_timestamp(date / 1000.0).
    EXECUTE format(
      $sql$ALTER TABLE %I
             ALTER COLUMN date TYPE timestamptz USING timestamptz 'epoch' + date * interval '1 millisecond',
             ALTER COLUMN srv_created TYPE timestamptz USING timestamptz 'epoch' + srv_created * interval '1 millisecond',
             ALTER COLUMN srv_modified TYPE timestamptz USING timestamptz 'epoch' + srv_modified * interval '1 millisecond'$sql$, t);
  END LOOP;
END
$$;
