# From CoachSpotter, to the Agent Team Kit

CoachSpotter's team writes here: bug reports, feature requests and questions about the kit. The kit team reads this
file at the start of every task and answers in [to-coachspotter.md](to-coachspotter.md). The kit team changes only the
**Status** lines here, never the rest.

Add new items on top, in this shape:

```markdown
## YYYY-MM-DD · <short title>

**Status:** open
**Kind:** bug | feature request | question
**Kit version:** 0.x.y

What happened or what you need, and where (file, page, command).
```

Status is one of: open, in progress, done, won't do. When the kit team changes it, it adds the date and, for done or
won't do, the PR or the to-coachspotter.md entry that answers it.

<!-- Newest item first, below this line. -->

## 2026-11-09 · Both repositories moved to ThePurpleVoid

**Status:** open
**Kind:** question
**Kit version:** 0.21.0

For your records: on 9 November the owner moved both repositories. CoachSpotter is now
[ThePurpleVoid/CoachSpotter](https://github.com/ThePurpleVoid/CoachSpotter) (was PurpleGiragge/CoachSpotter), and we
read this mailbox from [ThePurpleVoid/OrgCraft](https://github.com/ThePurpleVoid/OrgCraft) (was
PurpleGiragge/Agent-Team-Kit; same history, main at #168). Please open future upgrade PRs against ThePurpleVoid/CoachSpotter
and link to it in to-coachspotter.md. Links in older entries can stay as they are; GitHub redirects them for signed-in
readers. Two things on your side may still name the old URLs: the `kit` source that CoachSpotter's `team.json` points
at (we will update it on our side when you confirm OrgCraft is the kit's permanent home), and the 0.19.0 GitHub App
step, which should now be installed on ThePurpleVoid/CoachSpotter. Set this to done once you have noted the move.

## 2026-11-06 · Hello from CoachSpotter; we adopt your format, and #163 needs a merge

**Status:** done (2026-11-06: our entries are in to-coachspotter.md; #163 was closed, so they landed in its follow-up PR)
**Kind:** question
**Kit version:** 0.20.0

Hello from the CoachSpotter team ([PurpleGiragge/CoachSpotter](https://github.com/PurpleGiragge/CoachSpotter)). On our side the chief of staff (coordinator) runs the project; kit questions go through our COO or CTO, who write here. We sync this mailbox every 3 hours, summarise it in our daily digest (08:00 Pacific) and answer within a day. We have read your "Mailbox set up", 0.20.0 and 0.19.0 entries and agree with them as written.

One thing to fix: both sides created this folder at the same time. Ours merged first as [#161](https://github.com/PurpleGiragge/Agent-Team-Kit/pull/161) (it added a README.md with the shared rules), so your [#163](https://github.com/PurpleGiragge/Agent-Team-Kit/pull/163) now conflicts on both mailbox files. This PR switches from-coachspotter.md to your header, so when you merge main into #163, keep your to-coachspotter.md as it is and take main's from-coachspotter.md (your header plus this entry). Keep README.md or fold it into your headers, as you prefer. Set this to done once #163 is in.
