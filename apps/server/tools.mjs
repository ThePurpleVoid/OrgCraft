// The control plane's own check of the team tools, `tools/1` (docs/contracts/team-tools.md). The runner checks
// first for quick feedback (apps/runner/tools.mjs); this is the authority (m3-design section 3), so it shares no
// code with the runner and needs no dependency. Pure: no I/O. Returns { input } (cleaned) or { problems }.

export const TOOL_NAMES = ['report', 'handoff', 'bug', 'signoff', 'blocked', 'ask_owner', 'request_approval'];
const MAX = 4000;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const ROLE = /^[a-z0-9][a-z0-9-]*(#[A-Za-z0-9._-]+)?$/;
const STATUSES = ['idle', 'working', 'waiting', 'blocked', 'review', 'done'];

const isLink = (s) => typeof s === 'string' && s.length <= 2000 && (/^https:\/\/\S+$/.test(s) || (/^[^/\s][^\s]*$/.test(s) && !s.split('/').includes('..') && !/^[a-z]+:/i.test(s)));

function fields(input, problems) {
  const a = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const text = (k, { need = false, max = MAX } = {}) => {
    const v = a[k];
    if (v === undefined || v === null) { if (need) problems.push(`${k} is required`); return undefined; }
    if (typeof v !== 'string') { problems.push(`${k} must be text`); return undefined; }
    if (v.length > max) problems.push(`${k} must be at most ${max} characters`);
    if (need && !v.trim()) problems.push(`${k} is required`);
    return v;
  };
  const int = (k, { min = 1, max = Number.MAX_SAFE_INTEGER, need = false } = {}) => {
    let v = a[k];
    if (v === undefined || v === null) { if (need) problems.push(`${k} is required`); return undefined; }
    if (k === 'issue' && typeof v === 'string' && /^#?[1-9]\d*$/.test(v)) v = Number(v.replace(/^#/, ''));
    if (!Number.isSafeInteger(v) || v < min || v > max) { problems.push(`${k} must be a whole number from ${min}${max < Number.MAX_SAFE_INTEGER ? ` to ${max}` : ''}`); return undefined; }
    return v;
  };
  const links = (k, { need = false } = {}) => {
    const v = a[k];
    if (v === undefined || v === null) { if (need) problems.push(`${k} needs at least one link: a screenshot or a log`); return need ? undefined : undefined; }
    if (!Array.isArray(v)) { problems.push(`${k} is a list of links`); return undefined; }
    if (v.length > 20) problems.push(`${k} holds at most 20 links`);
    for (const l of v) if (!isLink(l)) { problems.push(`${k} must hold https:// URLs or paths in the workspace`); break; }
    if (need && !v.length) problems.push(`${k} needs at least one link: a screenshot or a log`);
    return v;
  };
  const role = (k, { need = false } = {}) => {
    const v = text(k, { need, max: 200 });
    if (v !== undefined && !ROLE.test(v)) problems.push(`${k} must be a role slug, such as web-dev or code-reviewer#57`);
    return v;
  };
  return { a, text, int, links, role };
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Checks one call. `ctx`: { role, frontDoor (boolean), frontDoorRole, roster (role slugs), reportsTo }.
 */
export function checkTool(name, input, ctx) {
  if (!TOOL_NAMES.includes(name)) return { problems: [`there is no team tool called ${name}`] };
  const problems = [];
  const f = fields(input, problems);
  const work = () => {
    const issue = f.int('issue'), task = f.text('task', { max: 200 });
    if (!issue && !task?.trim()) problems.push('needs an issue or a task, so the work can be found again');
    return { issue, task };
  };
  let out;
  switch (name) {
    case 'report': {
      const status = f.a.status;
      if (!STATUSES.includes(status)) problems.push(`status must be one of ${STATUSES.join(', ')}`);
      out = { status, task: f.text('task', { max: 200 }), waitingOn: f.text('waitingOn', { max: 200 }), issue: f.int('issue'), pr: f.int('pr'), branch: f.text('branch', { max: 200 }), commit: f.text('commit', { max: 80 }), detail: f.text('detail') };
      if (['working', 'waiting'].includes(status) && !out.task?.trim()) problems.push(`a ${status} report needs the task`);
      if (status === 'waiting' && !out.waitingOn?.trim()) problems.push('a waiting report needs waitingOn: a role, or a short reason such as "CI on PR 57"');
      break;
    }
    case 'handoff':
      out = { to: f.role('to', { need: true }), ...work(), changed: f.text('changed', { need: true }), verify: f.text('verify', { need: true }), doneWhen: f.text('doneWhen', { need: true }), branch: f.text('branch', { max: 200 }), commit: f.text('commit', { max: 80 }), pr: f.int('pr') };
      if (f.a.artifact !== undefined && !isLink(f.a.artifact)) problems.push('artifact must be an https:// URL or a path in the workspace');
      else out.artifact = f.a.artifact;
      break;
    case 'bug':
      out = { to: f.role('to', { need: true }), ...work(), where: f.text('where', { need: true, max: 500 }), steps: f.text('steps', { need: true }), expected: f.text('expected', { need: true }), actual: f.text('actual', { need: true }), severity: f.int('severity', { min: 1, max: 4, need: true }), evidence: f.links('evidence', { need: true }), build: f.text('build', { max: 200 }) };
      break;
    case 'signoff':
      out = { to: f.role('to', { need: true }), ...work(), testedOn: f.text('testedOn', { need: true, max: 500 }), walked: f.text('walked', { need: true }), result: f.a.result, evidence: f.links('evidence', { need: true }), pr: f.int('pr') };
      if (!['pass', 'fail'].includes(out.result)) problems.push('result must be pass or fail');
      if (problems.some((p) => p.startsWith('evidence'))) problems.push('A SIGNOFF without evidence is refused');
      break;
    case 'blocked': {
      out = { ...work(), need: f.text('need', { need: true }), needFrom: f.text('needFrom', { need: true, max: 200 }), meanwhile: f.text('meanwhile', { need: true }), to: f.role('to'), recommendation: f.text('recommendation') };
      if (out.needFrom !== undefined && out.needFrom !== 'owner' && !SLUG.test(out.needFrom)) problems.push('needFrom must be a role slug or owner');
      if (out.needFrom === 'owner' && !out.recommendation?.trim()) problems.push('a question for the owner needs your recommendation');
      break;
    }
    case 'ask_owner': {
      if (!ctx.frontDoor) return { problems: [`No role asks the owner directly: send a BLOCKED to ${ctx.frontDoorRole ?? 'the front door'} with your recommendation`], forbidden: true };
      out = { question: f.text('question', { need: true, max: 300 }), recommended: f.text('recommended', { need: true, max: 100 }), why: f.text('why', { max: 200 }), context: f.text('context') };
      const opts = f.a.options;
      if (!Array.isArray(opts) || opts.length < 2 || opts.length > 4) problems.push('options needs 2 to 4 options');
      else {
        out.options = opts.map((o) => ({ id: o?.id, label: o?.label, consequence: o?.consequence }));
        for (const o of out.options) {
          if (typeof o.id !== 'string' || !SLUG.test(o.id)) problems.push('every option id must be a slug');
          if (typeof o.label !== 'string' || !o.label.trim() || o.label.length > 40) problems.push('every option needs a label of at most 40 characters');
          if (typeof o.consequence !== 'string' || !o.consequence.trim() || o.consequence.length > 200) problems.push('every option needs a consequence of at most 200 characters');
        }
        if (new Set(out.options.map((o) => o.id)).size !== out.options.length) problems.push('option ids must be different');
        if (out.recommended && !out.options.some((o) => o.id === out.recommended)) problems.push('recommended must be one of the option ids');
      }
      if (f.a.expires !== undefined && (typeof f.a.expires !== 'string' || Number.isNaN(Date.parse(f.a.expires)))) problems.push('expires must be an ISO 8601 date-time');
      else out.expires = f.a.expires;
      break;
    }
    case 'request_approval':
      out = { action: f.text('action', { need: true, max: 80 }), call: f.text('call', { need: true }), why: f.text('why', { need: true }), links: f.links('links'), pr: f.int('pr'), headSha: f.text('headSha', { max: 64 }) };
      if (f.a.risk !== undefined && !['low', 'medium', 'high'].includes(f.a.risk)) problems.push('risk must be low, medium or high');
      else out.risk = f.a.risk;
      if (out.headSha !== undefined && !/^[0-9a-f]{7,64}$/.test(out.headSha)) problems.push('headSha must be a commit sha');
      // D1: an approval to accept (merge) is bound to the exact head the person saw.
      else if (out.action === 'accept' && out.headSha && !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(out.headSha)) problems.push('an accept approval needs the full head sha (40 or 64 hex characters)');
      if (out.action === 'accept' && (!out.pr || !out.headSha)) problems.push('an accept approval needs pr and headSha, so the merge can only land on the commit that was approved');
      break;
    default: break;
  }
  // Messages go to another role of this team version, never to the caller.
  for (const target of [out.to, name === 'blocked' && out.needFrom && out.needFrom !== 'owner' ? out.needFrom : null].filter(Boolean)) {
    const base = target.split('#')[0];
    if (base === ctx.role) problems.push('a message goes to another role, never to yourself');
    else if (ctx.roster?.length && !ctx.roster.includes(base)) problems.push(`${base} is not a role on this team (roles: ${ctx.roster.join(', ')})`);
  }
  return problems.length ? { problems: [...new Set(problems)] } : { input: clean(out) };
}

/** The kit's composed `detail` for a message, so sinks forward something readable to a team's own board. */
export function detailOf(name, i) {
  const parts = {
    handoff: [['Changed', i.changed], ['Verify', i.verify], ['Done when', i.doneWhen]],
    bug: [['Where', i.where], ['Steps', i.steps], ['Expected', i.expected], ['Actual', i.actual], ['Build', i.build]],
    signoff: [['Tested on', i.testedOn], ['Walked', i.walked], ['Result', i.result]],
    blocked: [['Need', i.need], ['From', i.needFrom], ['Meanwhile', i.meanwhile], ['Recommendation', i.recommendation]],
  }[name] ?? [];
  return parts.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join(' ').slice(0, 4000);
}
