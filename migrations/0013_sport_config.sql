-- Sport mode, as an admin set it on the Access page: switching it on from the
-- glucose page writes a Profile Switch to `percentage` of the profile (the one
-- in use, or `profile` from the profile store) for `duration` minutes (0: until
-- it is ended) and, if `target` (mg/dL) is set, an Activity temp target for as
-- long (24 hours with no limit). At most one row.
CREATE TABLE sport_config (
  id          boolean PRIMARY KEY DEFAULT true CHECK (id),
  percentage  integer NOT NULL,
  duration    integer NOT NULL,
  target      double precision,
  profile     text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);
