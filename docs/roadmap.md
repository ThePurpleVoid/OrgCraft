# OrgCraft roadmap

The short version of the [vision](product/vision.md), which the owner signed off on 2026-11-09. Every screen in the design carries one of four phase tags. A tag means the same thing here and in the architecture: **Now** means it's specced and everything it needs is in the six-month plan.

| Phase | Horizon | Means |
|---|---|---|
| Now | next 6 months | Specced and in the build plan |
| Next | 6–18 months | Designed, and builds on Now with no new foundations |
| Later | 18 months – 4 years | Needs a new foundation: hosting at scale, native apps, a marketplace, enterprise |
| Decade | 4–10 years | Where OrgCraft goes if it wins |

## Rules that hold in every phase

1. The team is the model, not the flow.
2. The owner decides anything irreversible: sending outside, paying, deleting, deploying, signing. A standing rule is the owner deciding in advance, and the server enforces it.
3. No AI teammate ever reads a secret.
4. Text from outside the team is information, never instructions.
5. Your team's definition is portable: plain files, exportable at any time.
6. Every claim shows its evidence.
7. Industry-neutral: nothing assumes code, engineering words or a particular role.
8. Works on a phone.
9. Online first, and local still possible.
10. Bring your own AI model.
11. No dependency on one provider account.
12. Tooltips wherever they help.

## The 24 core areas

| # | Area | Now | Next | Later and Decade |
|---|---|---|---|---|
| 1 | Organization builder | Org chart canvas; Role catalog; Teammate card + inspector; Auto-layout and views | Departments and lanes; People on the chart; Org health check | Vacancies and hiring suggestions; Org history; Several organizations, one owner; the self-organizing team |
| 2 | Per-teammate wiring view (n8n-style) | Wiring view; Wire inspector | Team wiring overview; Test a wire | suggested wiring |
| 3 | Custom roles, skills, models and quality | Guided role editor | Skills and knowledge; Model per teammate; Evaluation sets; Role versions | Compare models; roles that learn |
| 4 | Templates and domain packs | Template gallery; Connect its systems | All industries; Import; Pack preview | Community packs; Publish your own pack |
| 5 | Publish with change safety | Publish sheet; Rollout view | Versions and rollback; Scheduled publish; Review the org change; Freeze | Policy checks; Staging team |
| 6 | Connections catalog | Catalog; Connector detail | Any web API; Code tool; n8n bridge; Connector health | Marketplace; Fixed flows; Computer use and browser |
| 7 | Credentials | Credentials list; Add a credential | Rotation and expiry; Per-team and shared; Access log | Bring your own vault |
| 8 | Triggers, all eight families | Triggers list + canvas cards; Trigger editor, by type; Test listener; History; Notices | — | triggers from the world |
| 9 | Work and the run inspector | Work list; Task timeline as a branch graph; Step detail; Cost per step; Run controls | Replay a step; Compare two tasks; Try a role; Explain this task | what-if |
| 10 | Chat | Chat with the team's lead | Chat with any teammate; Files; Search chat | Voice; Group chat |
| 11 | Approvals | Approval card; Ledger; Standing rules; Approval inbox | Delegation; Out of office; Approval wait report | approval budgets |
| 12 | Meetings | Meetings list and editor; Discussion meeting; Minutes, decisions, action items | People in meetings; Calendar sync | Live voice meeting |
| 13 | Live board and dashboards | Home; By teammate; Embed | By stage; By cost; Department view | By customer; Build your own dashboard |
| 14 | Governance | Unverified line on handoffs; Sign-offs tied to a version, stale when it changes; Plan → build → review → check → ship → learn | Separation of duties map; Lessons | — |
| 15 | Budget and spend | Caps; Cost warning | Forecast | Invoices and billing; Price changes; Cost per outcome |
| 16 | Compliance pack | "What AI teammates can never do" | Audit log; Data retention | Data residency; Evidence for audits; Legal hold; AI rules by region; Auditor access |
| 17 | Security and people's access | People and roles; Sign-in; Incident view; Teammate isolation | Devices and sessions; Security events | — |
| 18 | Long-term memory | — | Decisions; "This touches an old decision"; Team memory per teammate; Search everything; Mailboxes between teams | institutional memory |
| 19 | Deployments | Where it runs; Runners | Upgrade OrgCraft itself; Status page | Hybrid |
| 20 | Notifications and channels | Channels; Rules; Digest settings; Delivery log | — | — |
| 21 | Mobile | Phone control room; Pause and stop | — | Native apps; Watch |
| 22 | Several teams and several companies | — | Organization switcher; Teams that talk; Shared roles and packs in an organization | Agency mode; a federation of companies |
| 23 | Reports | — | Weekly report; Role report card; Export and share | Benchmarks |
| 24 | Help and onboarding | First-run guide; The two-minute video; The 13-step demo mode; Finding detail; Where OrgCraft runs; Outage mode; What AI teammates can never do; Kill switches; Draft diff before Publish | In-product tips; Help center and ask-a-question; Review queue; Checks and evidence; Ready to try checklist; Practice run / Demo mode; Runner fleet; Topology and health; Backups and restore; Secrets and keys inventory; Cost of running; Setup wizard; Threat model; Permission matrix; Capability card on every teammate; Subprocessors and terms; Security settings; Recover this organization; Developer platform; Event browser; Versions; What's new; Fleet versions; Team format upgrade; Import report; Memory viewer; Role-by-model table; Who woke whom; A question mid-step; Flow lens; Embed | Incidents and on-call; Data requests; White-label; Operator console |

## Ten more areas

| # | Area | Phase |
|---|---|---|
| 25 | Teammates that talk to your customers | Next / Later |
| 26 | Quality and evaluations, team level | Next |
| 27 | Portability and the developer platform | Now (CLI, files) / Next (API, SDK) |
| 28 | Account and plans (our own billing) | Later |
| 29 | End-customer data rights | Later |
| 30 | Accessibility and languages | Next |
| 31 | Incidents and on-call for the team itself | Next |
| 32 | Sandbox and practice mode, team level | Next |
| 33 | Search and command palette | Next |
| 34 | Trust centre (public) | Later |

## Decisions taken

- **No repository needed to start.** The team can live in OrgCraft's own storage, exportable as files at any time (owner, 2026-11-09).
- **Plans with placeholder prices:** Free, Team, Business, Enterprise. Free and Team use shared accounts with fair-use limits. Business and Enterprise bring their own code-host app and AI model account. Bring-your-own is available on every plan (owner, 2026-11-09).
- **Connectors through MCP.** We connect to tools like n8n, and we never host or embed them.
- **People on the chart** come in Next. **Teammates that talk to customers** come in Next, with a required disclosure line. **Fixed flows** come Later, and only as a tool a role can use.
- **Our own marketplace** comes Later. The revenue share is still open.
