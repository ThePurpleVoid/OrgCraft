# Team tools, `tools/1`

The tools a role can call during a run. Each one is a protocol the briefs already describe (`docs/team/protocols.md`), now checked instead of trusted. The runner's team tool server offers them to every session as MCP tools; the control plane checks every call again at `POST /v1/sessions/{session}/tools/{tool}` and records it ([M3 design](../product/m3-design.md) section 3).

Rules:

- The **actor is never part of the input.** The server takes the role, instance, session, run and team version from the session token, so one role cannot speak as another.
- A refused call returns `422` with `problems`, a list of plain sentences the model can act on ("evidence needs at least one link: a screenshot or a log"). Nothing is stored except a `session.tool` event with `decision: refused` and the audit row.
- `to` is a role slug the session's team version has, optionally `#instance`, and never the caller itself.
- Text fields are at most 4,000 characters; `evidence` and `links` hold at most 20 links of at most 2,000 characters each. A link is an `https://` URL or a path in the session's workspace.
- `issue` is optional everywhere: a team whose work is not in an issue tracker names its task with `task` instead. Every message needs an `issue` or a `task`.
- Every emitted message event keeps the kit's report fields (`to`, `task`, `issue`, `pr`, `branch`, `commit`, `severity`, `evidence`, `detail`) so sinks forward it to a team's own board unchanged. The server composes `detail` from the structured fields and stores them beside it.
- Readers ignore input fields they do not know, and new optional fields are additive within `tools/1`.

## `report`

| Field | Required | Check |
| --- | --- | --- |
| `status` | yes | one of `idle`, `working`, `waiting`, `blocked`, `review`, `done` |
| `task` | when `status` is `working` or `waiting` | |
| `waitingOn` | when `status` is `waiting` | a role slug or a short reason ("CI on PR 57") |
| `issue`, `pr` | no | positive integers |
| `branch`, `commit`, `detail` | no | |

Emits `report.status` (`data.to` is `waitingOn` when it is a role). Wakes nobody. Result: `{ "event": "<id>" }`.

## `handoff`

| Field | Required | Check |
| --- | --- | --- |
| `to` | yes | see the rules |
| `issue` or `task` | yes | |
| `changed` | yes | what changed |
| `verify` | yes | how to verify it |
| `doneWhen` | yes | when the receiver is done |
| `branch`, `commit`, `pr` | no | |
| `artifact` | no | a link: a build, a preview URL, a document |

Emits `message.handoff`, with `evidence: [artifact]` when given and `detail` = "Changed: … Verify: … Done when: …". Wakes `to`. Result: `{ "event": "<id>" }`.

## `bug`

| Field | Required | Check |
| --- | --- | --- |
| `to` | yes | |
| `issue` or `task` | yes | |
| `where` | yes | the screen, page, document or step |
| `steps`, `expected`, `actual` | yes | |
| `severity` | yes | 1 (worst) to 4 |
| `evidence` | yes | at least one link |
| `build` | no | the build, commit or version tested |

Emits `message.bug`. Wakes `to`. Result: `{ "event": "<id>" }`.

## `signoff`

| Field | Required | Check |
| --- | --- | --- |
| `to` | yes | |
| `issue` or `task` | yes | |
| `testedOn` | yes | where it was tested: device or browser, system, commit or version |
| `walked` | yes | what was walked |
| `result` | yes | `pass` or `fail` |
| `evidence` | yes | **at least one link.** A SIGNOFF without evidence is refused |
| `pr` | no | |

Emits `message.signoff`. Wakes `to`. Result: `{ "event": "<id>" }`.

## `blocked`

| Field | Required | Check |
| --- | --- | --- |
| `issue` or `task` | yes | |
| `need` | yes | what is needed |
| `needFrom` | yes | from whom: a role slug or `owner` |
| `meanwhile` | yes | what the role does while it waits (the recommended option, unless the step cannot be undone) |
| `to` | no | defaults to the caller's `Reports to` role; `owner` questions go to the front door |
| `recommendation` | when `needFrom` is `owner` | |

Emits `message.blocked` and a `report.status` with `status: blocked`. Wakes `to`. Result: `{ "event": "<id>" }`.

## `ask_owner`

Only the team's **front door** (the role whose `Reports to` is `owner`) may call it. Any other role is refused with "No role asks the owner directly: send a BLOCKED to <front door> with your recommendation".

| Field | Required | Check |
| --- | --- | --- |
| `question` | yes | at most 300 characters |
| `options` | yes | 2 to 4, each `{ id, label, consequence }`; `id` is a slug, `label` at most 40 characters, `consequence` at most 200 |
| `recommended` | yes | one of the option ids |
| `why` | no | why that one, at most 200 characters |
| `context` | no | Markdown subset (clients.md section 6) |
| `expires` | no | ISO 8601; default 7 days |

Emits `decision.requested` (with `cardId` and `session`) and `card.updated` with a `decision` card. Returns at once with `{ "card": "<id>" }`: the role keeps working on its recommendation. The answer arrives as `decision.answered`, which wakes the session.

## `request_approval`

| Field | Required | Check |
| --- | --- | --- |
| `action` | yes | a classification from the team's policy (for example `accept`, `deploy-production`, `destructive-data`, `secret-write`, `payment`, `outbound-message`); unknown values are allowed and treated as needing approval |
| `call` | yes | the exact command or tool call that will run once approved; secrets are redacted before storage |
| `why` | yes | |
| `risk` | no | `low`, `medium`, `high` |
| `links` | no | for example the pull request |

Emits `approval.requested` (with `cardId` and `session`) and `card.updated` with an `approval` card whose approve option has `stepUp: true`. The HTTP call returns `{ "approval": "<id>", "card": "<id>" }`; the runner's tool server then holds the tool result until `approval.result` arrives, and returns `{ "approval": "<id>", "decision": "approved" | "denied" | "expired", "note": "…" }` to the model.

## `meeting_reply`

Only the attendee whose turn it is, in an open meeting of the caller's run, once per turn. Any instance of that role may answer; the actor records which.

| Field | Required | Check |
| --- | --- | --- |
| `meeting` | yes | the id from the turn, `mtg_…` |
| `text` | yes | at most 8,000 characters; stored verbatim and shown to later attendees |

Emits `meeting.replied`, then the next `meeting.turn` (or the facilitator's closing turn). Result: `{ "event": "<id>" }`. Refused with "it is not your turn in …" or "meeting … is not taking replies".

## `meeting_close`

Only the meeting's facilitator, on its closing turn (also when the meeting reached its cap).

| Field | Required | Check |
| --- | --- | --- |
| `meeting` | yes | the id from the turn |
| `minutes` | yes | at most 20,000 characters; partial minutes say so when the meeting was capped |
| `actionItems` | no | at most 20, each `{ to, task, doneWhen }`: `to` as in the rules, `task` at most 200 characters |
| `decisions` | no | at most 4, each `{ question, options, recommended, why }`, checked like `ask_owner` |

Emits `meeting.closed` (outcome `completed` or `capped`); the minutes as a `chat.message` from the facilitator when the definition's `owner.minutes` is set (the default); a `report.note` linking the meeting page; a `message.handoff` per action item; and per decision a `decision` card when the facilitator is the front door, otherwise a `message.blocked` to the front door with `needFrom: owner` and the recommendation, because no other role asks the owner directly. All carry `data.meeting`. Minutes are never committed to a repository. Result: `{ "event": "<id>" }`.

## `meeting_start`

Only the team's **front door** may call it. Any other role is refused with 403: "Only the front door starts a meeting: send a BLOCKED to <front door> asking for one". It opens an unscheduled meeting in the written-round format, run by the front door, with `ifBusy: next-pause`.

| Field | Required | Check |
| --- | --- | --- |
| `title` | yes | at most 200 characters |
| `agenda` | no | |
| `attendees` | yes | 1 to 20 role slugs of this team, the caller left out |
| `cap` | no | `{ amount, currency }`: whole minor units in the budget's currency, **at most the team's meeting cap** (`meetingCap`, or a tenth of `perDay` when that is null). Without it the meeting cap applies |

Refused with 422 when there is no run, the cap is above the meeting cap, or today's budget (less what open meetings still hold) is below the cap. Only a person raises the meeting cap, with step-up. Emits `meeting.opened` with `adhoc: true` and the first `meeting.turn`. Result: `{ "meeting": "mtg_…", "attendees": [...], "cap": <minor units>, "currency": "USD" }`.
