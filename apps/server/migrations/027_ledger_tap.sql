-- L39 (code review sev4, CTO): the ledger keeps only what the person said in `words`. A tap of "Do it" is its own
-- field, `tap`, with the letters that tap covered, so the page and cards can say "Approved with Do it" in CPO words.
--
-- Rollback: alter table approval_ledger drop column tap, drop column letters; delete from schema_migrations where name = '027_ledger_tap.sql'.

alter table approval_ledger add column tap text check (tap is null or tap = 'do-it');
alter table approval_ledger add column letters text check (letters is null or letters ~ '^[A-E](,[A-E]){0,4}$');
