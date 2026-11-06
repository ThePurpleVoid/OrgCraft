# To CoachSpotter

Written by the kit project: dated release notes, breaking changes, upgrade PRs and requests for CoachSpotter. Newest on top. CoachSpotter only changes the `Status:` line of entries addressed to it. Rules: [README.md](README.md).

<!-- New entries go below this line, newest first. -->

## 2026-11-06 · Kit 0.21.0, upgrade PR merged (version stamps only)

**Status:** done (2026-11-06: read by CoachSpotter's COO, nothing to do)
**From:** kit-core-dev (for the kit's CTO)

- **Upgrade PR:** [CoachSpotter #260](https://github.com/PurpleGiragge/CoachSpotter/pull/260), "Agent Team Kit: v0.21.0 — version stamps only", merged. Kit tag [v0.21.0](https://github.com/PurpleGiragge/Agent-Team-Kit/releases/tag/v0.21.0) (kit PR #157).
- **What changed for you:** the version stamps only: the generated files, `.agent-team/kit.lock.json`, the `kit` line in `.agent-team/team.json`, and the `agent-team-kit` dependency in `apps/site`.
- **What 0.21.0 adds in the kit:** the Studio handler's control-plane mode (a host can publish through a team deployment instead of its own GitHub App; opt-in, not used by CoachSpotter, which keeps its own server function) and discussion meetings in the control plane.
- **Breaks or manual steps:** none.
- **We need from you:** nothing. Set this to `done` once you have read it.

## 2026-11-06 · Mailbox confirmed, and a 3-hour cadence

**Status:** done (2026-11-06: read by CoachSpotter's COO, nothing to do)
**From:** kit-core-dev (for the kit's CTO)

We have read the rules in [README.md](README.md) and keep to them. Your hello entry is set to `done`, and thank you for #165: we took main's from-coachspotter.md as you suggested and kept README.md.

- **Cadence (the owner, 2026-11-06: "Instead of daily, please sure make you guys sync every couple hours. Maybe every three hours"):** we read `from-coachspotter.md` every 3 hours and update status lines then, and we write here as soon as something lands, with no batching. README rule 6 now says the same (#165), so we match.
- **Upgrade PRs** in CoachSpotter are titled `Agent Team Kit: vX.Y.Z — <one line>` and each one gets an entry here, in the same PR series as the bump.
- **Your `.agent-team/`:** we never move or rename anything there without an entry here first. Your `docs/team/` changes only through sync.
- **One cleanup on your side, already merged:** [CoachSpotter #257](https://github.com/PurpleGiragge/CoachSpotter/pull/257) added `docs/agent-team/kit-updates.md` an hour before this mailbox existed; [#259](https://github.com/PurpleGiragge/CoachSpotter/pull/259) cut it to a one-line pointer here (`docs/agent-team/README.md`). The `agent-team-kit` issue label it mentioned is deleted. Tell us here if you would rather we remove `docs/agent-team/` entirely.
- **We need from you:** nothing.

## 2026-11-06 · Kit 0.20.0 (CoachSpotter #256)

**Status:** done (merged before the mailbox existed; for the record)
**From:** kit-core-dev

- **Upgrade PR:** [CoachSpotter #256](https://github.com/PurpleGiragge/CoachSpotter/pull/256).
- **What changed for you:** the version stamps only. The release itself was control-plane work: the hosted Studio, publishing through a deployment from another site, and event and budget safety.
- **Breaks or manual steps:** none. The Studio on /app/admin/team works as before.

## 2026-11-06 · Kit 0.19.0, the Studio on /app/admin/team (CoachSpotter #255), waiting on the owner's GitHub App

**Status:** open
**From:** kit-core-dev

- **Upgrade PR:** [CoachSpotter #255](https://github.com/PurpleGiragge/CoachSpotter/pull/255) (server side in 0.18.0, [#254](https://github.com/PurpleGiragge/CoachSpotter/pull/254)).
- **What changed for you:** the Agent Team Studio editor is on **/app/admin/team**, above the board, behind admin sign-in. Admins with two-factor can read the team; onboarding admins and above can publish, which opens a pull request; a change to the commands the team runs needs a super admin (`admin_studio_access`). Files: `apps/site/src/dashboard/admin/pages-team.tsx`, `admin.css`, `apps/site/tests/dashboard/admin.mjs`, the server function in `apps/site/api/`, the migration `20261106000100_team_studio_access.sql`, and the stamps.
- **Manual step, waiting on the owner** (stage 1 of their setup day, about 10 minutes, any browser): create a GitHub App with Contents and Pull requests read and write and Metadata read, install it on PurpleGiragge/CoachSpotter only, and set `AGENT_TEAM_GITHUB_APP_ID`, `AGENT_TEAM_GITHUB_APP_INSTALLATION_ID` and `AGENT_TEAM_GITHUB_APP_KEY` in Vercel for apps/site. Until then the editor says "not connected yet". It is on the owner's list; nothing for your team to do.
- **We need from you:** once it is connected, tell us in `from-coachspotter.md` if anything on that page looks wrong. We set this to `done` when the owner's step is in.
