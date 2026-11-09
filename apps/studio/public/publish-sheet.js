// The Publish sheet's words (B5.1, L14): one plain line per change in the draft, and the "Widens access" block the
// server computes for every draft (capabilityDiff, ADR 0013 rule 2). Pure functions of the change items, so the
// sheet, the commit message and the tests all say the same thing.
import { t } from './i18n.js';
import { LEVELS } from './wiring.js';

/** "Read", "Change" or "Act" for a binding permission. */
export const levelWord = (p) => t(LEVELS.find(([k]) => k === p)?.[1] ?? 'perm.read');

/**
 * One plain line per change (B5.1-1). `name(id)` gives a teammate's or role's title, `system(id)` a system's name.
 * A hands-to change can say two things, so this returns a list.
 */
export function changeLines(c, name, system = (x) => x) {
  const who = c.role ? name(c.role) : '';
  const list = (ids) => ids.map(name).join(', ');
  switch (c.kind) {
    case 'role-added': return [t('change.role-added', { teammate: who })];
    case 'role-off': case 'role-removed': return [t('change.role-off', { teammate: who })];
    case 'member-added': return [t('change.member-added', { teammate: who, role: name(c.type) })];
    case 'member-renamed': return [t('change.member-renamed', { from: c.from, to: c.to })];
    case 'type-changed': return [t('change.type-changed', { teammate: who, role: name(c.to), from: name(c.from) })];
    case 'pool': return [t('change.pool', { teammate: who, from: Number.isNaN(c.from) ? 1 : c.from, to: Number.isNaN(c.to) ? 1 : c.to })];
    case 'hands-to': {
      const out = [];
      if (c.added?.length) out.push(t('change.hands-to', { teammate: who, added: list(c.added) }));
      if (c.removed?.length) out.push(t('change.hands-to.removed', { teammate: who, removed: list(c.removed) }));
      return out.length ? out : [t('change.brief', { teammate: who })];
    }
    case 'reports-to': return [t('change.reports-to', { teammate: who, to: name(c.to) })];
    case 'tier': return [t('change.tier', { teammate: who, from: c.from, to: c.to })];
    case 'brief': case 'role-dormant': return [t('change.brief', { teammate: who })];
    case 'binding-added': case 'binding-widened': return [t('change.binding-added', { teammate: who, system: system(c.resource), level: levelWord(c.to) })];
    case 'binding-removed': case 'binding-narrowed': return [t('change.binding-removed', { teammate: who, system: system(c.resource) })];
    case 'path-moved': return [t('change.path-moved', { area: c.path, from: name(c.from), to: name(c.to) })];
    default: return [t('change.other', { detail: c.detail })];
  }
}

/** One line for a "Widens access" item. `subjects` (several seats) and `'*'` (every seat) read as names or "Every teammate". */
export function widensLine(x, name, system = (s) => s) {
  const who = x.subject === '*' ? '' : x.subject ? name(x.subject) : (x.subjects ?? []).map(name).join(', ');
  const v = { teammate: who, teammates: who, system: system(x.resource ?? ''), from: x.from ?? '', to: x.to ?? '' };
  switch (x.kind) {
    case 'seat-added': return t('widens.seat-added', v);
    case 'type-changed': return t('widens.type-changed', { ...v, role: name(x.to) });
    case 'binding-added': return t('widens.binding-added', { ...v, level: levelWord(x.to) });
    case 'binding-widened': return t('widens.binding-widened', { ...v, from: levelWord(x.from), to: levelWord(x.to) });
    case 'owns-added': return t('widens.owns-added', { ...v, area: x.path });
    case 'model-changed': return t('widens.model-changed', v);
    case 'cap-raised': return t('widens.cap-raised', { ...v, from: Number.isNaN(x.from) || x.from == null ? 1 : x.from });
    case 'review-removed': return t('widens.review-removed', { ...v, reviewer: name(x.reviewer) });
    case 'check-removed': return t('widens.check-removed', { target: x.target, check: x.check });
    case 'check-changed': return t('widens.check-changed', { target: x.target, check: x.check });
    case 'resource-widened': {
      // One kind of widening gets its own line; more than one, or new secrets or settings, the general one.
      const sys = { ...v, system: system(x.resource ?? x.subject ?? '') };
      const only = [x.secrets?.length && 'secrets', x.command && 'command', x.tools?.length && 'tools', x.effects?.length && 'effects', x.egress?.length && 'egress', x.tier && 'tier'].filter(Boolean);
      const settings = / changes its settings/.test(x.detail ?? '');
      if (only.length === 1 && !settings) {
        if (only[0] === 'command') return t('widens.resource-command', sys);
        if (only[0] === 'tools') return t('widens.resource-tools', { ...sys, tools: x.tools.map((g) => g.tool).join(', ') });
        if (only[0] === 'effects') return t('widens.resource-effects', { ...sys, tools: x.effects.map((g) => g.tool).join(', ') });
        if (only[0] === 'egress') return t('widens.resource-egress', { ...sys, hosts: x.egress.join(', ') });
        if (only[0] === 'tier') return t('widens.resource-tier', { ...sys, tier: t(`tier.${x.tier.from}`) });
      }
      return t('widens.resource-widened', sys);
    }
    // L40 (kit-core-dev systemsCapability): a new system is listed before anyone is bound to it.
    case 'system-added': return t('widens.system-added', { system: system(x.resource ?? ''), type: x.type ?? '' });
    default: return x.detail ?? '';
  }
}

// The checks the Studio runs on every draft, by what they look at. A check passes when it finds no error; warnings
// are listed but don't fail it (B5.1-4 shows the same list the canvas does).
export const CHECKS = ['roles', 'reporting', 'areas', 'gates', 'systems', 'meetings', 'team'];
const checkOf = (where = '') => (/^roles\//.test(where) ? 'roles' : /^ownership/.test(where) ? 'areas' : /^gates/.test(where) ? 'gates'
  : /^resources/.test(where) ? 'systems' : /^meetings/.test(where) ? 'meetings' : 'team');

/** Checks: {passed} of {total} (B5.1-1): which of CHECKS found an error, counting the canvas's looks as reporting. */
export function checksTally(issues, looks) {
  const failed = new Set(issues.filter((i) => i.level === 'error').map((i) => checkOf(i.where)));
  if (looks.length) failed.add('reporting');
  return { passed: CHECKS.length - failed.size, total: CHECKS.length, failed: [...failed] };
}

// ------------------------------------------------------------------------------------------------ the sheet (B5.1)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Words for the kinds diffTeams has beyond the CPO's list (pending CPO wording, i18n PENDING). */
function moreLines(c, name) {
  switch (c.kind) {
    case 'path-added': return [t('change.path-added', { area: c.path, teammate: name(c.to) })];
    case 'path-removed': return [t('change.path-removed', { area: c.path, from: name(c.from) })];
    case 'gate': return [t('change.gate', { target: c.target === 'all' ? t('change.gate.all') : c.target })];
    case 'meeting': return [t('change.meeting', { meeting: c.meeting })];
    case 'rules': return [t('change.rules')];
    case 'values': return [t('change.values')];
    case 'options': return [t('change.settings')];
    default: return null;
  }
}

/**
 * The draft's changes as the sheet lists them (B5.1-1): [{ change, text }], one per plain line. `changes` comes from
 * diffTeams; `changedRoles` and `changedData` (the Studio's own comparison) add a line for anything diffTeams leaves
 * out, such as an off role's text or the team settings, so the sheet and "Publish {n} changes" always agree.
 */
export function sheetLines(changes, { name, system = (x) => x, changedRoles = [], changedData = [] } = {}) {
  const out = [];
  for (const c of changes) for (const text of moreLines(c, name) ?? changeLines(c, name, system)) out.push({ change: c, text });
  const roles = new Set(changes.map((c) => c.role).filter(Boolean));
  for (const slug of changedRoles) if (!roles.has(slug)) out.push({ change: { kind: 'brief', role: slug }, text: t('change.brief', { teammate: name(slug) }) });
  const covered = { ownership: /^path-/, gates: /^gate$/, resources: /^binding-/, meetings: /^meeting$/, values: /^values$/, rules: /^rules$/, options: /^options$/ };
  for (const k of changedData) if (!changes.some((c) => covered[k]?.test(c.kind))) out.push({ change: { kind: k === 'options' ? 'options' : 'other', key: k }, text: moreLines({ kind: k }, name)?.[0] ?? t('change.settings') });
  return out;
}

/** The "Widens access" block (ADR 0013 rule 2), first in the sheet; empty when the draft widens nothing. */
export function widensHtml(items, name, system) {
  if (!items?.length) return '';
  return `<h3>${esc(t('publish.section.widens'))}</h3><p class="hint">${esc(t('publish.widens.hint'))}</p>
    <ul class="clist">${items.map((x) => `<li><span class="dot warn" aria-hidden="true"></span>${esc(widensLine(x, name, system))}</li>`).join('')}</ul>
    <p class="hint">${esc(t('publish.widens.passkey'))}</p>`;
}

/** Checks: {passed} of {total} passed, then the same list the canvas shows (B5.1-4). */
export function checksHtml(issues, looks) {
  const tally = checksTally(issues, looks);
  const list = [...issues.map((i) => ({ level: i.level, text: `${i.where ? `${i.where}: ` : ''}${i.message ?? i.text ?? ''}` })), ...looks.map((l) => ({ level: 'warning', text: l.text }))];
  return `<h3>${esc(t('publish.section.checks'))}</h3>
    <p class="${tally.failed.length ? 'warnline' : 'pass'}">${esc(t('publish.checks', tally))}</p>
    ${list.length ? `<ul class="clist">${list.map((i) => `<li class="${i.level === 'error' ? 'error' : 'warnline'}"><span class="dot ${i.level === 'error' ? 'error' : 'warn'}" aria-hidden="true"></span>${esc(i.text)}</li>`).join('')}</ul>` : ''}`;
}

/** What changes: one line per change, each with its own Undo (unless `undo` is off, as for a team's first publish). */
export function changesHtml(lines, { undo = true } = {}) {
  return `<h3>${esc(t('publish.section.changes'))}</h3>
    <ul class="clist">${lines.map((l, i) => `<li><span class="dot accent" aria-hidden="true"></span><span class="ctext">${esc(l.text)}</span>${undo && lines[i - 1]?.change !== l.change ? `<button type="button" class="link" data-undo-line="${i}" aria-label="${esc(t('publish.undo.aria', { 'change line': l.text }))}">${esc(t('publish.undo'))}</button>` : ''}</li>`).join('')}</ul>`;
}
