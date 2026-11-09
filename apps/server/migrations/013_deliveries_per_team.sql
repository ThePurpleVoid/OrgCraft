-- Deliveries are once per (team, event, role, instance), not per (event, role, instance) (review-2 D1).
-- An event id is unique only within its team (events: unique (team, id)), and some ids are deterministic
-- (published-<sha>; N2's schedule slots). With no team in the key, a second team holding the same event id, in this
-- tenant or another, lost its delivery to `on conflict do nothing` with no error. Row-level security hid the other
-- row but the unique index still saw it.
--
-- Rollback: create unique index deliveries_once on deliveries(event, role, coalesce(instance, '')) (fails if two
-- teams now share an event id), drop index deliveries_once_team; delete from schema_migrations where name = '013_deliveries_per_team.sql'.

create unique index deliveries_once_team on deliveries(team, event, role, coalesce(instance, ''));
drop index deliveries_once;
