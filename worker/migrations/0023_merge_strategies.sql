-- Merge strategies (issue #42).

-- Pull request merge methods a repo allows, and the one offered first.
-- Branch rulesets can narrow the list further (`merge_methods` rule).
ALTER TABLE repos ADD COLUMN merge_methods TEXT NOT NULL DEFAULT '["merge","squash","rebase"]';
ALTER TABLE repos ADD COLUMN default_merge_method TEXT NOT NULL DEFAULT 'merge';

-- How a pull request landed and the changeset its target moved to (the merge
-- commit, the squash commit or the last rebased commit).
ALTER TABLE pull_requests ADD COLUMN merge_method TEXT;
ALTER TABLE pull_requests ADD COLUMN merged_cs TEXT;
