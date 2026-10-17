-- Access without roles: an access token reads, or reads and writes; a person
-- reads, and an admin also manages access (tokens and people).

ALTER TABLE subjects ADD COLUMN can_write boolean NOT NULL DEFAULT false;
-- Every role except these read-only ones allowed some writing.
UPDATE subjects SET can_write = true
 WHERE EXISTS (SELECT 1 FROM unnest(roles) r WHERE r NOT IN ('readable', 'status-only', 'denied'));
ALTER TABLE subjects DROP COLUMN roles;

ALTER TABLE users ADD COLUMN is_admin boolean NOT NULL DEFAULT false;
UPDATE users SET is_admin = true WHERE 'admin' = ANY (roles);
ALTER TABLE users DROP COLUMN roles;

DROP TABLE roles;
