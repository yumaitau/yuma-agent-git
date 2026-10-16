-- Unique logins: member grants resolve `user_login` to one user, so two users
-- must never share a login (case-insensitively, as GitHub compares them).
-- Existing duplicates keep the name for one holder: a user without GitHub
-- first (OIDC and SCIM users only got a free name, so a GitHub user reached
-- it later by renaming), then the oldest. The rest get a random suffix.
UPDATE users SET login = login || '-' || lower(hex(randomblob(3)))
WHERE EXISTS (
  SELECT 1 FROM users o
  WHERE lower(o.login) = lower(users.login) AND o.id <> users.id
    AND (
      (o.github_id IS NULL) > (users.github_id IS NULL)
      OR ((o.github_id IS NULL) = (users.github_id IS NULL)
          AND (o.created_at, o.id) < (users.created_at, users.id))
    )
);
CREATE UNIQUE INDEX idx_users_login ON users(login COLLATE NOCASE);
