-- RBAC (issue #14): repo creators are admins.
ALTER TABLE repos ADD COLUMN created_by TEXT;
