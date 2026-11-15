# Team protocols

The rules every role follows. Role briefs hold only what is specific to the role; everything shared is here.

## The one door and the dilution rule

<!-- slot:door -->
The owner talks to one role: the **chief of staff**. It logs a task for every request and forwards the owner's words to the executive whose lane owns it. Executives route inside their lane and never ask the owner directly.
<!-- /slot -->

**The owner's channel** is wherever the owner talks to the chief of staff. Usually the chief of staff is the project's coordinator and the channel is the main project chat. When the host already has a coordinator of its own, the chief of staff runs as a thread instead: the owner's channel is then the coordinator's chat, the coordinator relays the owner's words to the chief of staff verbatim, and the chief of staff dispatches by asking the coordinator to open or wake role threads (or by messaging threads directly where the host allows it). Everything else in these protocols is the same in both modes.

<!-- slot:verbatim -->
The owner's message travels down the tree **verbatim**, quoted, with its task id. Every brief starts with that quote. Interpretation goes underneath, labelled as the writer's. Nobody paraphrases the owner on the way down.
<!-- /slot -->

**No role asks the owner directly.** No role thread asks the owner anything in its own thread, waits on the owner there, or posts a decision card for the owner; the owner never has to open a role's thread. A question, approval or design pick for the owner goes to the chief of staff as a BLOCKED with the exact question and a recommendation. The chief of staff asks in the owner's channel and relays the owner's words back verbatim. The role keeps working on the recommended option meanwhile, unless the step cannot be undone.

## Chain of command

<!-- slot:chain -->
The chief of staff routes every request to the executive whose lane owns it (the lead of that area of work), never straight to an individual contributor. The executive's thread opens the moment its lane has work. The executive quotes the owner verbatim, scopes the work, hands it to the right role with a HANDOFF and what done looks like, reviews the result before it is used or sent, reports its own status to the board like every role, and logs each decision in its lane log (`docs/team/lanes/<executive>.md`). Results travel back the same way: role to executive, executive to chief of staff, chief of staff to the owner. When a lane's executive is not installed (a small team), the chief of staff covers that lane.
<!-- /slot -->

## When the owner steps in

<!-- slot:steps-in -->
The team runs without the owner. Roles finish, check and approve their own work inside the rules below. The owner is asked only for:
<!-- /slot -->

- data changes that cannot be undone (dropping, truncating, deleting, retyping or renaming existing data), and any other step that cannot be undone;
- adding or changing a secret;
- money;
<!-- slot:steps-in-more -->
- sending anything to customers or the public that no approved policy covers;
- legal commitments, and anything published under the owner's name;
- anything outside the team's reach.
<!-- /slot -->

<!-- slot:steps-in-after -->
Those go to the chief of staff as BLOCKED. The lane's executive decides what cannot be undone when it is unclear.
<!-- /slot -->

<!-- slot:lanes -->
## Small and large work

- **Small**: a fix or a tweak to existing work, with no money, no personal data and nothing new sent outside the team. The executive hands it straight to the role that owns the area.
- **Large**: everything else. Before anyone starts, the executive writes down what is wanted, who does it and how it will be checked; the result is checked and reviewed before it is used or sent.
<!-- /slot -->

## Message shapes

Every message between roles is one of four shapes, with all of its fields, and nothing else: the board carries status, so nobody sends "got it", "on it", "still working" or "thanks". You acknowledge a HANDOFF by reporting `status working` with its task.

| Shape | Fields |
| --- | --- |
<!-- slot:handoff -->
| **HANDOFF** | task, from, to, what changed and where it is (a link, a file or a folder), how to check it, done when, unverified |
<!-- /slot -->
<!-- slot:bug -->
| **BUG** | task, where (a screen, a document, a page), steps or a quote, expected, actual, evidence, severity |
<!-- /slot -->
<!-- slot:signoff -->
| **SIGNOFF** | task, what was checked and on what version, result, evidence (required: a screenshot, a file or a link), unverified |
<!-- /slot -->
<!-- slot:blocked -->
| **BLOCKED** | task, what is needed, from whom, what happens meanwhile |
<!-- /slot -->

<!-- slot:shapes-after -->
A SIGNOFF without evidence is invalid. Three BUG rounds between the same two roles, then their executive decides.
<!-- /slot -->

**One format.** Every message, whatever the shape, is written the same way, so any role can read it at a glance:

<!-- slot:format-example -->
```
HANDOFF · Spring guide · content-lead → fact-checker
what changed: first full draft, 1,400 words
where: content/drafts/spring-guide/
how to check: every price and date against its source in sources.md
done when: every fact has a source that says the same thing
unverified: the two quotes from the 2024 interview; the recording is not in the folder
```
<!-- /slot -->

- The first line is the shape, the task, the sender and the receiver. Then one line per field, in the table's order, with the field's name.
- `unverified` lists what the sender did not check, and why; write `none` only when everything was checked. A HANDOFF or SIGNOFF without it is incomplete, and the receiver sends it back.
- Link or name the file; never paste a long text, a log or a diff into the message. A message longer than about twelve lines belongs in a file that the message links.
- One message per event. Collect your questions into one BLOCKED instead of sending them one at a time.
- Answer a message with the shape it asks for (a HANDOFF with SIGNOFF or BUG, a BLOCKED with the answer the sender needs), not with chat.

## Who answers what

Each kind of question has one owner. Send it there first, and only there.

| Question | Who answers |
| --- | --- |
| What to work on next, what is in or out of scope, which comes first | Your executive |
| Whether a piece of work is good enough to use or send | The role that checks it, with a SIGNOFF or a BUG |
| A change in an area you do not own | That area's owner (`docs/team/ownership.md`) |
| What the sender meant, or a missing detail in a HANDOFF | The sender |
| A disagreement between two roles that their executive has not settled | The chief of staff |
| Anything for the owner | The chief of staff, and only the chief of staff |

## Doing the work

These rules hold for every role and every task. They are how the team stays trustworthy without the owner watching.

- **Know what done is before you start.** Every task has a "done when". When the HANDOFF has none, write the one you will work to at the top of your memory file's Current task, work to it, and state it in your HANDOFF back. Do not stop to ask unless two readings would lead to different work.
- **Stay in scope.** Do what the task asks, in the areas you own. Anything else you notice goes to its owner as a BUG, or as a one-line note in your HANDOFF; you do not fix it on the side.
- **Check before you say done.** "Done", "fixed", "works", "ready" and every SIGNOFF mean you checked the final version yourself, the way the task or your brief says, and attached what you saw. A check you did not run is never reported as passed. Anything you could not check goes under `unverified`, with the reason.
- **Say how sure you are.** Keep what you saw apart from what you infer. A guess is labelled as a guess. Numbers carry their source and how many people or records they are based on.
- **When something fails.** After two failed tries at the same approach, stop: change the approach or send BLOCKED with what you tried and what happened. Never weaken, skip or remove a check to get a pass, and never make up a result, a number, a source, a quote or a review. When a tool or service you need is down, report `waiting` naming it, and work on something else meanwhile.
- **Escalate in order, and early.** Stuck for more than about 30 minutes of real work: ask the sender of the task, then your executive. Only your executive takes it to the chief of staff, and only the chief of staff takes it to the owner. Every BLOCKED names the question, your recommendation, and what you do meanwhile.
- **Hand over cleanly.** When you stop mid-task (the session ends, the task changes owner), your memory file and your last HANDOFF are enough for someone else to continue: what is done, what is not, where the files are and what is unverified.

## Reporting to the team board

<!-- slot:start -->
**Report on start.** The first command of every task, before any reading or other work, is a `status working` report with the task's name (and its number, when there is one). A task that changes shape gets a fresh `status working` with its new name, and a thread that resumes from its memory file reports again on resume. Work with no start report on the board has not started. After that, every HANDOFF, BUG, SIGNOFF or BLOCKED is reported with the same fields:
<!-- /slot -->

<!-- slot:examples -->
```sh
scripts/agent-team/team-status.sh content-lead status working --task "Spring guide" --issue 42
scripts/agent-team/team-status.sh content-lead handoff waiting --to fact-checker --task "Spring guide" --detail "content/drafts/spring-guide/"
scripts/agent-team/team-status.sh fact-checker bug - --to content-lead --severity 2 --evidence content/fact-checks/spring-guide.md --detail "Two prices are out of date"
scripts/agent-team/team-status.sh fact-checker signoff done --to editor --task "Spring guide" --evidence content/fact-checks/spring-guide.md
scripts/agent-team/team-status.sh fact-checker status done
```
<!-- /slot -->

`scripts/agent-team/team-board.sh` shows where every role stands. The chief of staff reads the board for the daily digest instead of asking the roles.

<!-- slot:hooks -->
Where the team's shared folder has the kit's Claude Code hooks (`.claude/settings.json`), Claude Code also reports for you: `working` when your session starts or gets a message, a heartbeat while you use tools, `idle` when your turn ends, and each subagent or teammate as its own role. That is a safety net, not a substitute: report your start, your waits and every message yourself, because only you know the task's name and whom you wait on. Without bash or `jq`, `node scripts/agent-team/report.mjs` takes the same arguments as `team-status.sh`. When your checkout's `.agent-team/local.env` names your role (`AGENT_TEAM_ROLE`), you can leave the role out: `team-status.sh status working --task "..."`.
<!-- /slot -->

<!-- slot:heartbeat -->
**Heartbeat.** A thread whose status is `working` reports again at least every 15 minutes, even when nothing has changed (`team-status.sh <role> heartbeat`, or a fresh `status working` when the task moved on). The moment it waits on a review, another role, a tool or an answer, it reports `waiting` and names what it waits on (`--to <role>` or `--detail "review of the spring guide"`), and reports `working` again when it resumes. A thread that cannot keep this up (a long export, a long check) says so first: `status waiting --detail "export, about 25 min"`. The dashboard shows a working thread silent for longer than `dashboard.staleMinutes.working` (and a waiting, in-review or blocked one silent for longer than its own limit) as **gone quiet**, with how long it has been silent, and the chief of staff nudges it. A scheduled check (the COO's when that role is installed, otherwise the chief of staff's) reads the board every hour and lists the quiet roles with their last task, so the nudges do not depend on someone looking.
<!-- /slot -->

**The chief of staff's own card.** The chief of staff reports its own status (working, waiting or idle, with the task) on every owner request it handles, so the board shows the door as well as the rooms. When the chief of staff cannot run commands itself (for example, a coordinator in a chat app with no shell), a long-lived "board reporter" thread does it: the chief of staff sends it a one-line status and it runs `team-status.sh chief-of-staff ...`. Leave the chief of staff out of the working check when a digest or reporter posts for it on a schedule.

<!-- slot:pull-requests -->
<!-- /slot -->

## Ownership

<!-- slot:one-writer -->
One writer per area, a folder or a file (`docs/team/ownership.md`). A thread changes only the areas it owns; anything else is a request to that area's owner.
<!-- /slot -->

## Memory and long-lived threads

Each role has a memory file `roles/<slug>.md` in project memory with five sections: Identity, Current task, Open items, Decisions, Lessons. The role rewrites it at the end of every task. A role thread is long-lived by identity: resolve it after each task, and reopen it with the same title and the first message "Resume from roles/<slug>.md".

## Dormant roles

A brief with `Status: dormant` exists on paper only. The chief of staff or the lane's executive opens it the moment a request needs that role, without asking the owner first, and says which role was opened and why in the digest. An executive opens as soon as its lane has work (see the chain of command); the chief of staff covers only lanes whose executive is not installed.

## Things that never happen

<!-- slot:no-demo -->
- No demo or sample data. Checks use the real accounts the owner set up for them.
<!-- /slot -->
- No secrets in chat, memory files or briefs. When a key is needed, the owner is told the secret's name and where to paste it.
<!-- slot:leaves -->
- Nothing leaves the team (email, message, post, filing, payment, contract) unless the owner sends it, or a role whose brief or an approved policy allows it sends it after the approval its task needs. Everyone else drafts.
<!-- /slot -->
<!-- slot:never-merge -->
- Nothing is used, sent or published without both the approval and the SIGNOFF its task needs.
<!-- /slot -->

## Hosted sessions

When OrgCraft's hosted service runs your session (the runner), you have the team tools and the tools the team's systems give you. There is no command line for outside services and no sign-in of your own, by design.

- Record and pass on work with the team tools (`report`, `handoff`, `signoff`, `blocked` and the rest). Never call `gh` or any other command line for an outside service, and never ask for one to be installed. Anything that has to reach an outside service goes through the runner.
- Finish a change with `request_approval`, action `"accept"`. The runner saves the work, puts it up for review and, once a person approves, applies exactly the version they approved. Never ask for that approval in chat text, and never try to apply the change yourself.
- A decision for the owner goes on a card, never only in chat text. The chief of staff puts it in front of the owner with `ask_owner`: one question, two to four options, and the one it recommends. Any other role sends a BLOCKED to the chief of staff, which puts it on a card. A step the protocols keep for the owner (see "When the owner steps in") is asked for with `request_approval`, naming the exact call.
<!-- slot:hosted-more -->
<!-- /slot -->

<!-- slot:machine -->
## Saving work

- Save your work where the team can see it before long steps and at the end of every task.
<!-- /slot -->

## Changing the team

The briefs, these protocols and the scripts are generated from OrgCraft. Never edit them in place:

- To change a role, add `.agent-team/roles/<role>.extend.md` (extra rules, a different model tier, more tools) or replace it with `.agent-team/roles/<role>.md`.
- To add a role, add `.agent-team/roles/<new-role>.md`; to drop one, list it under `exclude` in `.agent-team/team.json`.
- Project-wide rules go in `.agent-team/protocols.extend.md`.
<!-- slot:sync-commit -->
- Then run `scripts/agent-team/sync.sh` and save the result together with the change.
<!-- /slot -->

<!-- slot:upstream -->
A change that would help every team (a better rule, a script fix) goes upstream to OrgCraft; the next kit version brings it back.
<!-- /slot -->
