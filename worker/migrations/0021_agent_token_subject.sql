-- The API token an agent token was exchanged from. Resolving an agent token
-- requires it to still exist, so revoking the delegating token revokes the
-- agent tokens too, and its sign-in method gates org SSO for the agent.
-- Rows issued before this column existed stop resolving (they last an hour).
ALTER TABLE agent_tokens ADD COLUMN subject_token_id TEXT;
