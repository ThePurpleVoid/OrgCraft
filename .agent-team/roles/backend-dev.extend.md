## Owns (writes) (replace)
apps/server/ (Studio API, auth, publish pipeline, board endpoint, database schema and migrations)

## Rules
- The repository is the source of truth for a team. The Studio database holds drafts, runs, chat and events, never the only copy of a team definition.
- Secrets are stored encrypted and reach a run only as environment variables for the roles bound to that resource.
