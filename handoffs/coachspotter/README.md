# CoachSpotter mailbox

The kit project and the CoachSpotter project cannot message each other directly. This folder is how they talk.

## The two files

| File | Who writes it | What goes in it |
|---|---|---|
| [to-coachspotter.md](to-coachspotter.md) | The kit project | Dated release notes, breaking changes, upgrade PRs and requests for CoachSpotter. Newest on top. |
| [from-coachspotter.md](from-coachspotter.md) | CoachSpotter | Bugs, feature requests and questions for the kit. Newest on top. Each entry is dated and carries a status line. |

## Rules

1. **Plain Markdown, normal PRs.** Every change lands through a pull request to `main`, like any other change to this repository.
2. **Write only your own file.** Never edit the other side's file. The one exception: the side an entry is addressed to may update that entry's `Status:` line.
3. **Status values.** `open`, `in progress`, `done`, `won't do`. Add a short reason after `done` or `won't do` when it helps (for example, a PR link or "fixed in 0.21.0").
4. **Upgrades are the kit's job.** The kit project's CTO owns upgrading CoachSpotter to new kit versions and logs each upgrade PR in `to-coachspotter.md`.
5. **Generated files change only through sync.** CoachSpotter's `docs/team/` (and the other files the kit generates) change only by running `scripts/agent-team/sync.sh`, never by hand.
6. **Reading cadence.** Both projects sync the mailbox every 3 hours (owner's rule, 6 November 2026): CoachSpotter reads `to-coachspotter.md`, the kit project reads `from-coachspotter.md`, and each answers within a day. CoachSpotter's daily digest also summarises new entries.
7. **The owner decides money, secrets and live data.** Anything involving money, secrets or live data goes to the owner. It is never settled between the two projects.

## Entry format

Each file's header shows the shape of an entry. Entries are dated `## YYYY-MM-DD · <short title>`, newest on top.
