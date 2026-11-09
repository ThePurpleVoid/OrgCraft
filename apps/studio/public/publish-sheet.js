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
    case 'resource-widened': return t('widens.resource-widened', { ...v, system: system(x.resource ?? x.subject ?? '') });
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
