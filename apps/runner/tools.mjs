// The team tools, `tools/1` (docs/contracts/team-tools.md). Each one is a protocol the briefs already describe in
// docs/team/protocols.md: a board report, the four message shapes (HANDOFF, BUG, SIGNOFF, BLOCKED), the one door
// to the owner, and an approval when the owner steps in.
//
// This module is the runner's local check: quick feedback for the model with no round trip. The control plane
// checks every call again at POST /v1/sessions/{session}/tools/{tool} and is the authority; it also mints the
// event, with the actor taken from the session token. Pure: no I/O.
import { z } from 'zod';

export const TOOLS_VERSION = 'tools/1';
const MAX_TEXT = 4000;
const slug = /^[a-z0-9][a-z0-9-]*$/;
const meetingId = /^mtg_[A-Za-z0-9_-]{1,60}$/;
const role = z.string().regex(/^[a-z0-9][a-z0-9-]*(#[A-Za-z0-9._-]+)?$/, 'must be a role slug, such as web-dev or code-reviewer#57');
const issue = z.union([z.number().int().positive(), z.string().regex(/^#?[1-9]\d*$/)]).transform((v) => Number(String(v).replace(/^#/, '')));
const posInt = z.number().int().positive();
const text = (max = MAX_TEXT) => z.string().max(max, `must be at most ${max} characters`);
const need = (max = MAX_TEXT) => text(max).refine((s) => s.trim().length > 0, 'is required');
/** A link is an https:// URL or a path in the session's workspace. */
const link = z.string().max(2000).refine((s) => /^https:\/\/\S+$/.test(s) || (/^[^/\s][^\s]*$/.test(s) && !s.split('/').includes('..') && !/^[a-z]+:/i.test(s)), 'must be an https:// URL or a path in the workspace');
const links = z.array(link).max(20, 'holds at most 20 links');
const STATUSES = ['idle', 'working', 'waiting', 'blocked', 'review', 'done'];

const workItem = { issue: issue.optional(), task: text(200).optional() };
const needsWorkItem = (a) => (a.issue || a.task?.trim() ? null : 'needs an issue or a task, so the work can be found again');

export const TOOLS = {
  report: {
    description: 'Report your status to the team board. Report working (with the task) when you start, waiting (with what you wait on) the moment you wait, and done when you finish.',
    shape: { status: z.enum(STATUSES), task: text(200).optional(), waitingOn: text(200).optional(), issue: issue.optional(), pr: posInt.optional(), branch: text(200).optional(), commit: text(80).optional(), detail: text().optional() },
    check: (a) => (['working', 'waiting'].includes(a.status) && !a.task?.trim() ? `a ${a.status} report needs the task` : a.status === 'waiting' && !a.waitingOn?.trim() ? 'a waiting report needs waitingOn: a role, or a short reason such as "CI on PR 57"' : null),
  },
  handoff: {
    description: 'Send a HANDOFF to another role; it wakes that role. Say what changed, how to verify it, and when the receiver is done.',
    shape: { to: role, ...workItem, changed: need(), verify: need(), doneWhen: need(), branch: text(200).optional(), commit: text(80).optional(), pr: posInt.optional(), artifact: link.optional() },
    check: needsWorkItem,
  },
  bug: {
    description: 'Send a BUG to the role that owns the thing that is wrong. Evidence (a screenshot or a log) is required.',
    shape: { to: role, ...workItem, where: need(500), steps: need(), expected: need(), actual: need(), severity: z.number().int().min(1).max(4), evidence: links, build: text(200).optional() },
    check: (a) => needsWorkItem(a) ?? (a.evidence.length ? null : 'evidence needs at least one link: a screenshot or a log'),
  },
  signoff: {
    description: 'Send a SIGNOFF after testing. Evidence (screenshot or log links) is required: a SIGNOFF without evidence is refused.',
    shape: { to: role, ...workItem, testedOn: need(500), walked: need(), result: z.enum(['pass', 'fail']), evidence: links, pr: posInt.optional() },
    check: (a) => needsWorkItem(a) ?? (a.evidence.length ? null : 'evidence needs at least one link: a screenshot or a log. A SIGNOFF without evidence is refused'),
  },
  blocked: {
    description: 'Say you are BLOCKED: what you need, from whom (a role, or owner), and what you do meanwhile. A question for the owner goes to the front door this way, with your recommendation; keep working on it unless the step cannot be undone.',
    shape: { ...workItem, need: need(), needFrom: z.string().refine((s) => s === 'owner' || slug.test(s), 'must be a role slug or owner'), meanwhile: need(), to: role.optional(), recommendation: text().optional() },
    check: (a) => needsWorkItem(a) ?? (a.needFrom === 'owner' && !a.recommendation?.trim() ? 'a question for the owner needs your recommendation' : null),
  },
  ask_owner: {
    description: 'Front door only: put one decision in front of the owner as a card, with two to four options and the one you recommend. Returns at once; the answer arrives later as a message. Keep working on your recommendation meanwhile.',
    shape: {
      question: need(300),
      options: z.array(z.object({ id: z.string().regex(slug, 'must be a slug'), label: need(40), consequence: need(200) })).min(2, 'needs 2 to 4 options').max(4, 'needs 2 to 4 options'),
      recommended: z.string(), why: text(200).optional(), context: text().optional(), expires: z.iso.datetime({ offset: true }).optional(),
    },
    check: (a, ctx) => (!ctx.frontDoor ? `No role asks the owner directly: send a BLOCKED to ${ctx.frontDoorRole ?? 'the front door'} with your recommendation` : !a.options.some((o) => o.id === a.recommended) ? 'recommended must be one of the option ids' : new Set(a.options.map((o) => o.id)).size !== a.options.length ? 'option ids must be different' : null),
  },
  request_approval: {
    description: 'Ask the owner to approve a step the protocols keep for them (data that cannot be undone, a secret, money, a message to people outside the team, accepting a change, a production deploy). Name the exact call that will run. Waits until a person decides.',
    shape: { action: need(80), call: need(), why: need(), risk: z.enum(['low', 'medium', 'high']).optional(), links: links.optional() },
  },
  meeting_reply: {
    description: 'Your turn in a meeting: answer the agenda in a few sentences. It goes verbatim into the minutes, and later attendees read it. Only on your own turn, once.',
    shape: { meeting: z.string().regex(meetingId, 'is the meeting id from your turn, such as mtg_01…'), text: need(8000) },
  },
  meeting_close: {
    description: 'Facilitator only, on the closing turn: write the minutes and close the meeting. Action items become HANDOFFs to their roles. Decisions go to the owner (as a card from the front door, otherwise as a BLOCKED to the front door).',
    shape: {
      meeting: z.string().regex(meetingId, 'is the meeting id from your turn, such as mtg_01…'), minutes: need(20_000),
      actionItems: z.array(z.object({ to: role, task: need(200), doneWhen: need() })).max(20, 'holds at most 20 items').optional(),
      decisions: z.array(z.object({
        question: need(300), options: z.array(z.object({ id: z.string().regex(slug, 'must be a slug'), label: need(40), consequence: need(200) })).min(2, 'needs 2 to 4 options').max(4, 'needs 2 to 4 options'),
        recommended: z.string(), why: text(200).optional(),
      })).max(4, 'holds at most 4 decisions').optional(),
    },
    check: (a, ctx) => {
      for (const it of a.actionItems ?? []) {
        const base = it.to.split('#')[0];
        if (base === ctx.role) return 'an action item goes to another role, never to yourself';
        if (ctx.roster?.length && !ctx.roster.includes(base)) return `${base} is not a role on this team (roles: ${ctx.roster.join(', ')})`;
      }
      for (const d of a.decisions ?? []) if (!d.options.some((o) => o.id === d.recommended)) return 'every decision\'s recommended must be one of its option ids';
      return null;
    },
  },
};

const schemas = Object.fromEntries(Object.entries(TOOLS).map(([k, t]) => [k, z.object(t.shape)]));

/**
 * The local check of one call. `ctx`: { role, frontDoor (boolean: this session is the team's front door),
 * frontDoorRole, roster (role slugs of the team version, when known) }.
 * Returns { input } (the cleaned input to send on) or { problems: [plain sentences] }.
 */
export function checkTool(name, args, ctx) {
  if (!TOOLS[name]) return { problems: [`there is no team tool called ${name}`] };
  const parsed = schemas[name].safeParse(args ?? {});
  if (!parsed.success) return { problems: parsed.error.issues.map((i) => `${i.path.join('.') || name} ${i.message.replace(/^Invalid input: /, '')}`) };
  const a = parsed.data;
  const problems = [];
  for (const target of [a.to, name === 'blocked' && a.needFrom !== 'owner' ? a.needFrom : null].filter(Boolean)) {
    const base = target.split('#')[0];
    if (base === ctx.role) problems.push('a message goes to another role, never to yourself');
    else if (ctx.roster?.length && !ctx.roster.includes(base)) problems.push(`${base} is not a role on this team (roles: ${ctx.roster.join(', ')})`);
  }
  const p = TOOLS[name].check?.(a, ctx);
  if (p) problems.push(p);
  return problems.length ? { problems } : { input: a };
}
