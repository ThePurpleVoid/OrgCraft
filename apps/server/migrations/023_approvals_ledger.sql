-- L22 (ADR 0013, vision R11.2 and R11.3 Now): the approvals ledger and standing rules.
--
-- approval_ledger: every decision on an approval, in the deciding person's own words (their note), plus every standing
-- rule added, used and withdrawn. Append-only for the app: select and insert, never update or delete.
-- standing_rules: the owner deciding in advance, from a fixed list of kinds, each with a limit per period. The server
-- matches signed calls against the structured form only; the owner's words are kept beside it, never parsed.
--
-- Rollback: drop table standing_rule_uses, approval_ledger, standing_rules; alter table approvals drop column effect_targets; drop index events_outside_results;
-- delete from schema_migrations where name = '023_approvals_ledger.sql'.

create table standing_rules (
  id text primary key check (id ~ '^sr_[A-Za-z0-9_-]{8,40}$'),
  tenant text not null references tenants(id),
  team text not null references teams(id),
  -- The CPO's fixed list (strings-now.md §6b); refund, pay.known and send.known are enforced in Now.
  kind text not null check (kind in ('refund', 'reply', 'send.known', 'pay.known', 'merge', 'cost')),
  spec jsonb not null,
  spec_hash text not null check (spec_hash ~ '^[0-9a-f]{64}$'),
  words text not null check (length(words) between 3 and 2000),
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  withdrawn_at timestamptz,
  withdrawn_by text
);
create index standing_rules_live on standing_rules(team) where withdrawn_at is null;

create table standing_rule_uses (
  id bigserial primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  rule text not null references standing_rules(id),
  approval text not null,
  amount bigint check (amount is null or amount >= 0),
  recipient text check (recipient is null or length(recipient) <= 200),
  at timestamptz not null default now()
);
create index standing_rule_uses_rule on standing_rule_uses(rule, at);

create table approval_ledger (
  id bigserial primary key,
  tenant text not null references tenants(id),
  team text not null references teams(id),
  at timestamptz not null default now(),
  kind text not null check (kind in ('approved', 'denied', 'rule-used', 'declined-again', 'rule-added', 'rule-withdrawn')),
  approval text,
  rule text,
  by text not null,
  words text check (words is null or length(words) <= 4000),
  calls_hash text check (calls_hash is null or calls_hash ~ '^[0-9a-f]{64}$'),
  -- Where a person decided: chat (the card), approvals (POST /v1/approvals), email or slack; null for the server's own.
  channel text check (channel is null or channel in ('chat', 'approvals', 'email', 'slack'))
);
create index approval_ledger_team on approval_ledger(team, at);

-- A decline sticks: finding an earlier "no" to the same signed calls, or to the same tool acting on any of the same
-- targets (ledger.mjs targetsOf: "tool\nvalue" pairs, whatever field carried the value), so a re-ask for a slightly
-- different amount, a renamed field or one more target field still matches.
alter table approvals add column effect_targets text[] check (effect_targets is null or cardinality(effect_targets) <= 200);
create index approvals_denied_hash on approvals(team, calls_hash) where state = 'denied';
create index approvals_denied_targets on approvals using gin (effect_targets) where state = 'denied' and effect_targets is not null;
-- rule.never.outside: a call whose output came from outside the team, for this session, since a person last decided.
create index events_outside_results on events((envelope->'actor'->>'session'), received_at) where type = 'session.result' and envelope->'data'->>'outside' = 'true';

do $$ declare t text; begin
  foreach t in array array['standing_rules', 'standing_rule_uses', 'approval_ledger'] loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy tenant_only on %I using (tenant = current_setting('app.tenant', true)) with check (tenant = current_setting('app.tenant', true))$p$, t);
  end loop;
end $$;

grant select, insert, update on standing_rules to agent_team_app;
grant select, insert on standing_rule_uses, approval_ledger to agent_team_app;
grant usage on sequence standing_rule_uses_id_seq, approval_ledger_id_seq to agent_team_app;
