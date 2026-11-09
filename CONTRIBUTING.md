# Contributing

Thanks for helping. The kit is small on purpose: briefs, protocols, a few scripts and two tools. Contributions that keep it that way are the easiest to merge.

## Good first contributions

- A role brief the kit is missing (data engineer, SRE, localisation lead, ...). Start from `team/roles/_template.md`.
- A preset for a kind of team (`presets/<name>.txt`), for example an agency, an open-source maintainer team or a data team.
- Example gates in `templates/config.sh` or a new `examples/` project layer for a stack you know (Rails, Django, Go, Flutter, ...).
- A dashboard for the hosted board's read endpoint.
- Clearer wording anywhere. The briefs are read by agents and humans; plain words win.

## This repository has its own team

OrgCraft is built by a team defined with OrgCraft. `team/` is the kit's source, the role library every team gets. `.agent-team/` is this repository's own project layer and `docs/team/` is the team generated from it, pinned to the last kit release. Fix a brief for everyone in `team/`; change this repository's team in `.agent-team/`. [docs/product/team.md](docs/product/team.md) explains how that team works.

## Rules for briefs

- Keep the fields in the same order as `_template.md`, and keep the shared "Every thread, every task" footer word for word (only the slug changes).
- `**Model:**` starts with a tier: `deep`, `standard`, `routine` or `light`. Never a model name; tiers outlive models.
- Two to five rules per role. If a rule applies to every role, it belongs in `team/protocols.md`.
- No product, company or person names. Write "the owner", "customers", "the product". The kit is a framework; anything specific to one product belongs in that product's `.agent-team/` overlay.
- Changing a brief or protocol changes every team on its next sync. Say in the PR what existing teams will see.
- Every new role gets a row in `team/ownership.md` and appears in the org list in `team/project-instructions.md`.

## Before you open a pull request

```sh
node tools/roster.mjs --check team/roles   # the role library: 0 errors, 0 warnings
npm test                               # node tests, then the CLI and script tests
shellcheck -S warning scripts/*.sh templates/*.sh tests/*.sh examples/*/.agent-team/config.sh .agent-team/config.sh
scripts/agent-team/sync.sh check      # this repository's own team still matches its pinned kit release
```

Or run all of it at once: `scripts/agent-team/merge-gate.sh kit`.

Scripts must run on macOS's bash 3.2 as well as Linux bash: no `mapfile`, no associative arrays, no GNU-only flags. They must never fail the thread that calls them for a reporting problem; print one line and exit 0.

## Pull requests

One change per pull request, with what changed, why, and how you tested it. Update `CHANGELOG.md` under the unreleased heading.

## Code of conduct

Be kind, assume good intent, and keep discussion about the work. Maintainers may remove comments or contributors that make the project unwelcoming.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
