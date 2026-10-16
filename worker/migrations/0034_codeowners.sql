-- CODEOWNERS (issue #40): which agent identity submitted a review. Agent
-- reviews keep the delegating person in `author_id`; code owner approval
-- needs the agent itself, so an `@agent:` owner is satisfied only by that
-- agent and a person owner only by that person. NULL = a person (session or
-- personal token).
ALTER TABLE pull_reviews ADD COLUMN agent_id TEXT;
