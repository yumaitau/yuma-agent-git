-- Org SSO (issue #27 follow-up). With enforced = 1, org members reach org
-- repos only with a session (or a token minted from one) that signed in
-- through this IdP. The IdP is matched by issuer + client_id against the
-- instance's OIDC_PROVIDERS; client secrets stay Worker secrets.
CREATE TABLE org_sso (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id),
  protocol TEXT NOT NULL CHECK (protocol IN ('oidc','saml')), -- only 'oidc' is accepted today
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  enforced INTEGER NOT NULL DEFAULT 0,
  allowed_domains TEXT NOT NULL DEFAULT '[]', -- JSON array of lowercase domains
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- How the session that minted a token signed in. NULL for older tokens, which
-- therefore never satisfy an enforced org SSO.
ALTER TABLE api_tokens ADD COLUMN auth_method TEXT;

-- SCIM groups map to teams (#26) in the org the provisioning token is bound to.
ALTER TABLE scim_tokens ADD COLUMN org_id TEXT REFERENCES orgs(id);
CREATE TABLE scim_groups (
  team_id TEXT PRIMARY KEY REFERENCES teams(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  display_name TEXT NOT NULL,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (org_id, display_name)
);
