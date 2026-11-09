# OrgCraft

**Build an organization of AI teammates, publish it, and run it with your approval on everything that matters.**

OrgCraft sits one layer above tools like n8n (which wires apps into flows) and gstack (which gives one coding agent a review-and-ship process). You lay out a team on a chart: roles, who reports to whom, which systems each teammate can use and how far it can go (Read, Change or Act), and what wakes it. Then you publish the team and talk to its lead. The teammates hand work to each other, check each other's work with evidence, and stop to ask you before anything irreversible: sending, paying, deleting or going live. It works for any kind of business, from a product team to a support desk, an online store or an agency. Your team is plain files you own, and you can export them at any time.

> **Status, November 2026:** the kit (0.21) is usable today as files plus an optional dashboard, Studio, control plane and runner. The new Studio design is signed off, and its first screens are being built. OrgCraft was called Agent Team Kit; the files still use `.agent-team/` for compatibility.

## The Studio design

The design the owner signed off on 2026-11-09 shows every screen across seven tabs: Home, Team, Work, Chat, Approvals, Connections and Settings. Each screen is tagged with when it ships.

- **[Vision, screen by screen](docs/product/vision.md)** covers 34 areas. It includes the ten-year rules that never change, the words we use, and every screen with its phase.
- **[Roadmap](docs/roadmap.md)** is the short version, by phase.
- The clickable mockup is a private preview for now. It will be published with the first Studio release.

## Roadmap at a glance

| Phase | When | What it brings |
|---|---|---|
| **Now** | next 6 months | The org chart builder with named teammates, a wiring view per teammate, templates, Publish with checks, connections and credentials your teammates never see, triggers, the task timeline, chat with the team's lead, approval cards with a passkey, the decision ledger, meetings, daily caps, notifications, a phone web layout, stop-everything, and a scripted 13-step demo |
| **Next** | 6–18 months | Hosted for everyone, people on the chart, departments, owner-written standing rules, teammates that talk to your customers (with a disclosure line), replay and practice runs, team-level quality checks, more connectors and a community tier, export and import of whole organizations |
| **Later** | 18 months – 4 years | Native phone apps, a marketplace for roles and packs, enterprise sign-in, data-rights tooling, dedicated and regional hosting, agencies running many client organizations |
| **Decade** | 4–10 years | Teams that propose their own org changes for you to approve, roles that learn from approved work, and organizations that run mostly on AI teammates, with people as owners, reviewers and specialists |

## Decisions already taken

- **No repository needed to start.** A team can live in OrgCraft's own storage, exportable as files at any time. Connecting a code host is optional.
- **Hosted plans** (prices are placeholders): Free (run it yourself), Team (hosted, using shared accounts with fair-use limits), Business and Enterprise (bring your own code-host app and AI model account). Bring-your-own is available on every plan.
- **Connectors through MCP.** We connect to tools such as your own n8n. We never host or embed them.
- **Bring your own model.** No role is tied to one AI vendor.

## Install

You need git and Node 18 or later.

```sh
cd ~/code/my-app
npx --yes github:ThePurpleVoid/OrgCraft#v0.21.1 init --preset engineering --project "My App" --owner "Sam"
```

That writes the role briefs, protocols and scripts into your repository. Nothing runs in the background, and nothing is sent anywhere. Then open your coding agent and say: *"You are the chief of staff. Read docs/team/roles/chief-of-staff.md and docs/team/protocols.md, then tell me what you need from me."* Install from npm comes later.

The full setup is in [Getting started](docs/getting-started.md). It covers presets, templates, the dashboard, the Studio, the control plane and the runner.

## How we work

OrgCraft is built by its own team. A chief of staff, a CTO, a CPO, developers, QA, reviewers and a release manager work as AI teammates, with one human owner who approves what matters. Every change has a reviewer, every sign-off names the version it checked, and the owner's decisions are kept in their own words ([how](docs/product/team.md)).

## More

- [How it works](docs/how-it-works.md)
- [Customizing your team](docs/customizing.md)
- [Running the team](docs/running-the-team.md)
- [The dashboard](docs/dashboard.md)
- [The Studio in your own app](docs/studio-in-your-app.md)
- [Other coding agents](docs/other-coding-agents.md)
- [Product plan and architecture](docs/product/)

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
