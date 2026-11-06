-- Delegated publish (docs/specs/studio-embed.md section 6, security C2): the consent text a person agreed to on a
-- host's consent page. Links made before this agreed to "chat, runs, decision cards" (version 1); publishing through a
-- host needs version 2, which says it "can open pull requests that change your team". hosts.mjs CONSENT_VERSION.
--
-- Rollback: alter table host_links drop column consent_version; delete from schema_migrations where name = '011_host_consent.sql'.

alter table host_links add column consent_version int not null default 1 check (consent_version >= 1);
