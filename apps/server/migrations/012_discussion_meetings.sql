-- Discussion meetings (phase 4, CPO D23): attendees answer each other for up to `rounds` rounds before the
-- facilitator closes. `round` is the round in progress; `done` lists attendees who said they have nothing more to add
-- (meeting_reply done: true), who get no later rounds. A written round is format 'round' with one round. A discussion
-- that passes its overall deadline (rounds x attendees x the turn deadline, at most four hours) is closed early:
-- `timed_out`.
--
-- Rollback: alter table meetings drop column format, drop column rounds, drop column round, drop column done,
-- drop column timed_out;
-- delete from schema_migrations where name = '011_discussion_meetings.sql'.

alter table meetings add column format text not null default 'round' check (format in ('round', 'discussion'));
alter table meetings add column rounds integer not null default 1 check (rounds between 1 and 5);
alter table meetings add column round integer not null default 1 check (round >= 1);
alter table meetings add column done jsonb not null default '[]';
alter table meetings add column timed_out boolean not null default false;
