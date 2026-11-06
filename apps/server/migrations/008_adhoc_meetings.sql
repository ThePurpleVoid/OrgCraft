-- Ad hoc meetings (G-15) and the team's default meeting cap. A meeting the front door starts from the chat has no
-- definition in meetings.json; when no cap is given it uses budgets.meeting_cap, else a tenth of the daily cap. The
-- cap is in the budget's currency and minor units and always counts inside the daily budget.
--
-- Rollback: alter table meetings drop column adhoc; alter table budgets drop column meeting_cap;
-- delete from schema_migrations where name = '008_adhoc_meetings.sql'.

alter table meetings add column adhoc boolean not null default false;
alter table budgets add column meeting_cap bigint check (meeting_cap is null or meeting_cap > 0);
