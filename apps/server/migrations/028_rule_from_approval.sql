-- L22m (qa-web D1): "Make this a standing rule" makes at most one rule from an approval, even from two windows. The
-- rule names the approval it was made from, and a second one from the same approval is refused by this index.
--
-- Rollback: drop index standing_rules_from_approval; alter table standing_rules drop column from_approval;
-- delete from schema_migrations where name = '028_rule_from_approval.sql'.

alter table standing_rules add column from_approval text check (from_approval is null or length(from_approval) <= 100);
create unique index standing_rules_from_approval on standing_rules (team, from_approval) where from_approval is not null;
