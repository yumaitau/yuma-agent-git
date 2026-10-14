-- Root tree pointer per changeset: hash of the rebuilt root tree written for
-- every commit (architecture §2.1). Trees are only rewritten along touched
-- paths; this column is what lets reads start the walk without a checkout.
ALTER TABLE changesets ADD COLUMN root_tree TEXT;
