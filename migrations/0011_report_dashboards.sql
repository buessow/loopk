-- The reports page's dashboard (widgets, layout, period) per signed-in
-- person, as the JSON public/reports.js builds. Stored here rather than only
-- in the browser so every device shows the same dashboard; the server does
-- not interpret it (src/reports/routes.js).
CREATE TABLE report_dashboards (
  email text PRIMARY KEY,
  dashboard jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
