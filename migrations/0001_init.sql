-- Nightscout APIv3 collections as explicit tables.
--
-- Every collection table starts with the same APIv3 bookkeeping columns. The
-- remaining columns are the fields AAPS (NSClient V3) reads and writes; see
-- src/db/schema.js for the mapping between document fields and columns.
-- jsonb is used only for parts that have no fixed structure: driver- or
-- settings-specific objects, and `extra`, which keeps any document fields a
-- client sends that this schema does not know.

-- --------------------------------------------------------------- entries

CREATE TABLE entries (
  identifier      text PRIMARY KEY,
  date            bigint,
  utc_offset      integer,
  created_at      timestamptz,
  app             text,
  device          text,
  subject         text,
  modified_by     text,
  srv_created     bigint NOT NULL,
  srv_modified    bigint NOT NULL,
  is_valid        boolean,
  is_read_only    boolean,

  type            text,
  date_string     text,
  sgv             double precision,
  mbg             double precision,
  direction       text,
  noise           double precision,
  filtered        double precision,
  unfiltered      double precision,
  rssi            double precision,
  delta           double precision,
  units           text,
  slope           double precision,
  intercept       double precision,
  scale           double precision,

  extra           jsonb
);
CREATE INDEX entries_date_idx ON entries (date);
CREATE INDEX entries_type_date_idx ON entries (type, date);
CREATE INDEX entries_srv_modified_idx ON entries (srv_modified);

-- --------------------------------------------------------------- treatments

CREATE TABLE treatments (
  identifier      text PRIMARY KEY,
  date            bigint,
  utc_offset      integer,
  created_at      timestamptz,
  app             text,
  device          text,
  subject         text,
  modified_by     text,
  srv_created     bigint NOT NULL,
  srv_modified    bigint NOT NULL,
  is_valid        boolean,
  is_read_only    boolean,

  event_type      text,
  mills           bigint,
  "timestamp"     bigint,
  -- glucose (BG Check)
  glucose         double precision,
  glucose_type    text,
  units           text,
  -- nutrition and insulin
  carbs           double precision,
  protein         double precision,
  fat             double precision,
  insulin         double precision,
  entered_insulin double precision,
  type            text,              -- NORMAL, SMB, PRIMING, FAKE_EXTENDED
  is_smb          boolean,
  is_basal_insulin boolean,
  pre_bolus       double precision,
  split_now       double precision,
  split_ext       double precision,
  -- durations, temp basal, extended bolus
  duration        double precision,  -- minutes
  duration_in_milliseconds bigint,
  percent         double precision,
  absolute        double precision,
  rate            double precision,
  relative        double precision,
  is_emulating_temp_basal boolean,
  -- temporary target
  target_top      double precision,
  target_bottom   double precision,
  -- profile switch / effective profile switch
  profile         text,
  percentage      double precision,
  timeshift       bigint,
  original_profile_name     text,
  original_customized_name  text,
  original_timeshift        bigint,
  original_percentage       double precision,
  original_duration         bigint,
  original_end              bigint,
  -- running mode, site management, notes
  mode            text,
  auto_forced     boolean,
  reasons         text,
  reason          text,
  location        text,
  arrow           text,
  notes           text,
  entered_by      text,
  is_announcement boolean,
  -- pump record linkage
  end_id          bigint,
  pump_id         bigint,
  pump_type       text,
  pump_serial     text,

  -- AAPS-internal records without a fixed schema
  bolus_calculator_result jsonb,     -- "Bolus Wizard" (sent as a JSON string)
  extended_emulated       jsonb,     -- copy of the extended bolus a temp basal emulates

  extra           jsonb
);
CREATE INDEX treatments_date_idx ON treatments (date);
CREATE INDEX treatments_created_at_idx ON treatments (created_at);
CREATE INDEX treatments_event_type_created_at_idx ON treatments (event_type, created_at);
CREATE INDEX treatments_srv_modified_idx ON treatments (srv_modified);

-- The profile embedded in a (effective) profile switch (`profileJson`).
CREATE TABLE treatment_profiles (
  treatment_identifier text PRIMARY KEY REFERENCES treatments (identifier) ON DELETE CASCADE ON UPDATE CASCADE,
  dia             double precision,
  units           text,
  timezone        text,
  carbs_hr        double precision,
  delay           double precision,
  extra           jsonb
);

CREATE TABLE treatment_profile_schedules (
  treatment_identifier text NOT NULL REFERENCES treatment_profiles (treatment_identifier) ON DELETE CASCADE ON UPDATE CASCADE,
  kind            text NOT NULL CHECK (kind IN ('basal', 'carbratio', 'sens', 'target_low', 'target_high')),
  position        integer NOT NULL,
  time            text,
  seconds         integer,
  value           double precision NOT NULL,
  PRIMARY KEY (treatment_identifier, kind, position)
);

-- --------------------------------------------------------------- devicestatus

CREATE TABLE devicestatus (
  identifier      text PRIMARY KEY,
  date            bigint,
  utc_offset      integer,
  created_at      timestamptz,
  app             text,
  device          text,
  subject         text,
  modified_by     text,
  srv_created     bigint NOT NULL,
  srv_modified    bigint NOT NULL,
  is_valid        boolean,
  is_read_only    boolean,

  uploader_battery         integer,
  is_charging              boolean,
  uploader_battery_percent integer,   -- uploader.battery

  pump_clock               text,
  pump_reservoir           double precision,
  pump_reservoir_display_override text,
  pump_battery_percent     integer,
  pump_battery_voltage     double precision,
  pump_status              text,
  pump_status_timestamp    text,
  pump_extended            jsonb,     -- pump driver specific

  -- openaps.iob
  iob_iob                  double precision,
  iob_basaliob             double precision,
  iob_bolusiob             double precision,
  iob_activity             double precision,
  iob_time                 text,

  -- openaps.suggested
  suggested_timestamp      text,
  suggested_deliver_at     text,
  suggested_bg             double precision,
  suggested_tick           text,
  suggested_eventual_bg    double precision,
  suggested_target_bg      double precision,
  suggested_insulin_req    double precision,
  suggested_carbs_req      double precision,
  suggested_cob            double precision,
  suggested_iob            double precision,
  suggested_rate           double precision,
  suggested_duration       double precision,
  suggested_units          double precision,  -- SMB
  suggested_sensitivity_ratio double precision,
  suggested_variable_sens  double precision,
  suggested_temp           text,
  suggested_reason         text,

  -- openaps.enacted
  enacted_timestamp        text,
  enacted_deliver_at       text,
  enacted_bg               double precision,
  enacted_tick             text,
  enacted_eventual_bg      double precision,
  enacted_target_bg        double precision,
  enacted_insulin_req      double precision,
  enacted_carbs_req        double precision,
  enacted_cob              double precision,
  enacted_iob              double precision,
  enacted_rate             double precision,
  enacted_duration         double precision,
  enacted_units            double precision,
  enacted_sensitivity_ratio double precision,
  enacted_variable_sens    double precision,
  enacted_temp             text,
  enacted_reason           text,
  enacted_received         boolean,

  -- configuration (AAPS settings, sent so followers can mirror them)
  configuration_pump        text,
  configuration_version     text,
  configuration_insulin     integer,
  configuration_aps         text,
  configuration_sensitivity integer,
  configuration_smoothing   text,
  insulin_configuration     jsonb,
  aps_configuration         jsonb,
  sensitivity_configuration jsonb,
  overview_configuration    jsonb,
  safety_configuration      jsonb,

  extra           jsonb
);
CREATE INDEX devicestatus_created_at_idx ON devicestatus (created_at);
CREATE INDEX devicestatus_srv_modified_idx ON devicestatus (srv_modified);

-- openaps.suggested/enacted.predBGs: one row per predicted value.
CREATE TABLE devicestatus_predictions (
  devicestatus_identifier text NOT NULL REFERENCES devicestatus (identifier) ON DELETE CASCADE ON UPDATE CASCADE,
  source          text NOT NULL CHECK (source IN ('suggested', 'enacted')),
  curve           text NOT NULL,     -- IOB, COB, UAM, ZT
  position        integer NOT NULL,
  value           double precision NOT NULL,
  PRIMARY KEY (devicestatus_identifier, source, curve, position)
);

-- --------------------------------------------------------------- profile

CREATE TABLE profile (
  identifier      text PRIMARY KEY,
  date            bigint,
  utc_offset      integer,
  created_at      timestamptz,
  app             text,
  device          text,
  subject         text,
  modified_by     text,
  srv_created     bigint NOT NULL,
  srv_modified    bigint NOT NULL,
  is_valid        boolean,
  is_read_only    boolean,

  default_profile text,
  start_date      text,
  mills           bigint,
  units           text,
  entered_by      text,

  extra           jsonb
);
CREATE INDEX profile_date_idx ON profile (date);
CREATE INDEX profile_srv_modified_idx ON profile (srv_modified);

-- One named profile in a profile document's `store`.
CREATE TABLE profile_stores (
  profile_identifier text NOT NULL REFERENCES profile (identifier) ON DELETE CASCADE ON UPDATE CASCADE,
  name            text NOT NULL,
  dia             double precision,
  units           text,
  timezone        text,
  carbs_hr        double precision,
  delay           double precision,
  start_date      text,
  extra           jsonb,
  PRIMARY KEY (profile_identifier, name)
);

CREATE TABLE profile_store_schedules (
  profile_identifier text NOT NULL,
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('basal', 'carbratio', 'sens', 'target_low', 'target_high')),
  position        integer NOT NULL,
  time            text,
  seconds         integer,
  value           double precision NOT NULL,
  PRIMARY KEY (profile_identifier, name, kind, position),
  FOREIGN KEY (profile_identifier, name) REFERENCES profile_stores (profile_identifier, name) ON DELETE CASCADE ON UPDATE CASCADE
);

-- --------------------------------------------------------------- food

CREATE TABLE food (
  identifier      text PRIMARY KEY,
  date            bigint,
  utc_offset      integer,
  created_at      timestamptz,
  app             text,
  device          text,
  subject         text,
  modified_by     text,
  srv_created     bigint NOT NULL,
  srv_modified    bigint NOT NULL,
  is_valid        boolean,
  is_read_only    boolean,

  type            text,
  name            text,
  category        text,
  subcategory     text,
  unit            text,
  portion         double precision,
  carbs           double precision,
  gi              double precision,
  energy          double precision,
  protein         double precision,
  fat             double precision,

  extra           jsonb
);
CREATE INDEX food_srv_modified_idx ON food (srv_modified);

-- --------------------------------------------------------------- heartrate

CREATE TABLE heartrate (
  identifier      text PRIMARY KEY,
  date            bigint,
  utc_offset      integer,
  created_at      timestamptz,
  app             text,
  device          text,
  subject         text,
  modified_by     text,
  srv_created     bigint NOT NULL,
  srv_modified    bigint NOT NULL,
  is_valid        boolean,
  is_read_only    boolean,

  duration        bigint,            -- milliseconds
  beats_per_minute double precision,

  extra           jsonb
);
CREATE INDEX heartrate_date_idx ON heartrate (date);
CREATE INDEX heartrate_srv_modified_idx ON heartrate (srv_modified);

-- --------------------------------------------------------------- settings

-- Settings documents have no fixed structure.
CREATE TABLE settings (
  identifier      text PRIMARY KEY,
  date            bigint,
  utc_offset      integer,
  created_at      timestamptz,
  app             text,
  device          text,
  subject         text,
  modified_by     text,
  srv_created     bigint NOT NULL,
  srv_modified    bigint NOT NULL,
  is_valid        boolean,
  is_read_only    boolean,

  extra           jsonb
);
CREATE INDEX settings_srv_modified_idx ON settings (srv_modified);

-- --------------------------------------------------------------- access

-- Access tokens ("subjects" in Nightscout) used by uploaders such as AAPS.
CREATE TABLE subjects (
  id           bigserial PRIMARY KEY,
  name         text NOT NULL UNIQUE,
  roles        text[] NOT NULL DEFAULT '{}',
  notes        text,
  access_token text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Role definitions (Apache Shiro style permission strings).
CREATE TABLE roles (
  name        text PRIMARY KEY,
  permissions text[] NOT NULL DEFAULT '{}',
  notes       text
);

INSERT INTO roles (name, permissions) VALUES
  ('admin', '{*}'),
  ('denied', '{}'),
  ('status-only', '{api:status:read}'),
  ('readable', '{*:*:read}'),
  ('careportal', '{api:treatments:create}'),
  ('devicestatus-upload', '{api:devicestatus:create}');

-- People who may sign in to the web UI with Google.
CREATE TABLE users (
  email      text PRIMARY KEY,
  name       text,
  picture    text,
  roles      text[] NOT NULL DEFAULT '{readable}',
  last_login timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Server secrets generated on first start (JWT signing key).
CREATE TABLE server_keys (
  name  text PRIMARY KEY,
  value text NOT NULL
);
