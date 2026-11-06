// The Meetings view: the team's meeting definitions (CPO story "meeting definitions editor", criteria 1 to 10;
// mockup 03; D19 to D28). It edits definitions only. Running meetings, minutes and "Start a meeting now" come with the
// runner (phase 3), so none of that shows here and no sample meetings or minutes ship (D19).
//
// A meeting is edited in a form and goes into the draft with "Save to the draft" (D27); Publish writes
// .agent-team/meetings.json with the rest of the team. The shape is the kit's (packages/team-model, meetings 0.11).
import { checkMeetings, meetingAttendees, meetingEstimate, meetingWhen } from './team-model.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LETTER = { mon: 'M', tue: 'T', wed: 'W', thu: 'T', fri: 'F', sat: 'S', sun: 'S' };
const DAY_NAME = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const money = (n) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '');

/** Starters (criterion 1): neutral words, so they fit any kind of team. */
export const STARTERS = {
  standup: {
    title: 'Daily standup', when: { days: WEEKDAYS, at: '09:00' }, skipIfQuiet: true, format: 'round',
    agenda: '1. What you finished since the last standup, with links.\n2. What you are doing next.\n3. What blocks you, and who could unblock it.',
  },
  planning: {
    title: 'Weekly planning', when: { days: ['mon'], at: '10:00' }, skipIfQuiet: false, format: 'round',
    agenda: '1. What you plan to finish this week, most important first.\n2. What you need from someone else to do it.\n3. Anything you think should wait.',
  },
  release: {
    title: 'Release readiness', when: { days: ['thu'], at: '15:00' }, skipIfQuiet: false, format: 'round',
    agenda: '1. Is your part ready to go out? Yes, no, or with a condition.\n2. What is still open, with links.\n3. What could go wrong, and how we would notice.',
  },
  retro: {
    title: 'Retro', when: { days: ['fri'], at: '16:00' }, skipIfQuiet: false, format: 'round',
    agenda: '1. What went well since the last retro.\n2. What slowed you down.\n3. One thing to change next time, and who owns it.',
  },
};
const STARTER_LABEL = { blank: 'Blank', standup: 'Daily standup', planning: 'Weekly planning', release: 'Release readiness', retro: 'Retro' };

const slugify = (s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'meeting';
const idPattern = /^[a-z0-9][a-z0-9-]*$/;

/**
 * The view. `ctx` gives: spec() (the draft), team() ([{ slug, title, group, reportsTo, dormant, md }] of roles on),
 * resolved() ([{ slug, md }] for the kit's functions), change(fn) (an undoable edit of the draft), prices() (the
 * price table or null), small() (phone width), dailyCapUsd(), timezone().
 */
export function createMeetings({ root, ctx }) {
  let selected = null; // a meeting id, or 'new'
  let form = null; // the meeting being edited, not yet saved
  let autoCap = false; // a new meeting's limit follows its estimate until the owner sets it
  let dirty = false;
  let note = '';

  const list = () => ctx.spec().meetings?.meetings ?? [];
  const titleOf = (slug) => ctx.team().find((r) => r.slug === slug)?.title ?? slug;
  const lanes = () => ctx.team().filter((r) => r.group === 'executive' || r.reportsTo === 'owner');
  const defaultRunner = () => {
    const on = ctx.team();
    return on.find((r) => r.slug === 'chief-of-staff')?.slug ?? on.find((r) => r.reportsTo === 'owner')?.slug ?? on[0]?.slug ?? '';
  };

  function fresh(starter) {
    const s = STARTERS[starter];
    const taken = new Set(list().map((m) => m.id));
    let id = slugify(s?.title ?? 'meeting'); for (let n = 2; taken.has(id); n++) id = `${slugify(s?.title ?? 'meeting')}-${n}`;
    return {
      id, title: s?.title ?? '', when: structuredClone(s?.when ?? { days: WEEKDAYS, at: '09:00' }),
      attendees: { roles: [], lanes: [], rule: null }, facilitator: defaultRunner(), format: s?.format ?? 'round', rounds: 1,
      agenda: s?.agenda ?? '', ifBusy: 'next-pause', owner: { minutes: true, speaks: false }, capUsd: 1, skipIfQuiet: s?.skipIfQuiet ?? false,
    };
  }

  /** The checks for the meeting in the form, as the kit runs them, against the draft with the form in it (criterion 10). */
  function formChecks() {
    if (!form) return [];
    const others = list().filter((m) => m.id !== (selected === 'new' ? null : selected));
    const all = { meetings: [...others, form] };
    const mine = checkMeetings(all, ctx.resolved(), { dailyCapUsd: ctx.dailyCapUsd() }).filter((i) => i.where === `meetings/${form.id}` || (i.where === 'meetings' && i.message.includes(`"${form.id}"`)));
    if (others.some((m) => m.id === form.id)) mine.unshift({ level: 'error', message: 'another meeting already has this name' });
    return mine;
  }

  // ---------------------------------------------------------------- the three columns

  function listHtml() {
    const items = list().map((m) => {
      const who = meetingAttendees(m, ctx.resolved());
      const n = who.roles.filter((s) => s !== m.facilitator).length;
      const people = `${n} role${n === 1 ? '' : 's'}${who.dynamic ? ' + who worked' : ''}`;
      return `<li><button type="button" class="meeting-row${m.id === selected ? ' selected' : ''}" data-meeting="${esc(m.id)}"><strong>${esc(m.title || m.id)}</strong><span class="muted">${esc(meetingWhen(m.when).replace(/`/g, ''))} · ${esc(people)} · ${m.format === 'discussion' ? 'discussion' : 'written round'}</span></button></li>`;
    }).join('');
    return `<div class="row meetings-head"><h2>Meetings</h2>${ctx.small() ? '' : `<details class="new-meeting"><summary class="primary-link">New meeting</summary><div class="menu">${Object.entries(STARTER_LABEL).map(([k, l]) => `<button type="button" data-starter="${k}">${esc(l)}</button>`).join('')}</div></details>`}</div>
      ${items ? `<ul class="plain meeting-list">${items}</ul>` : '<p class="muted">No meetings yet.</p>'}
      <p class="hint">Meetings run once the team's runner is connected. Until then they are definitions, published with the team.</p>`;
  }

  function attendeeChips() {
    const a = form.attendees;
    const chip = (kind, slug, label) => `<span class="chip">${esc(label)}<button type="button" class="link" data-remove-${kind}="${esc(slug)}" aria-label="Remove ${esc(label)}">×</button></span>`;
    return [...(a.lanes ?? []).map((s) => chip('lane', s, `${titleOf(s)}'s lane`)), ...(a.roles ?? []).map((s) => chip('role', s, titleOf(s)))].join('');
  }

  function formHtml() {
    const f = form;
    const event = f.when.label !== undefined;
    const on = ctx.team();
    const tz = ctx.timezone();
    const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; } })();
    const a = f.attendees;
    const dormantLane = (a.lanes ?? []).some((lane) => on.some((r) => r.dormant && reportsUp(r.slug, lane)));
    const radio = (name, value, title, text, checked) => `<label class="radio-card${checked ? ' on' : ''}"><input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}><span><strong>${esc(title)}</strong><span class="muted">${esc(text)}</span></span></label>`;
    const pickable = on.filter((r) => !(a.roles ?? []).includes(r.slug) && r.slug !== f.facilitator);
    const lanesFree = lanes().filter((r) => !(a.lanes ?? []).includes(r.slug));
    return `<form id="m-form" class="m-form" autocomplete="off">
      <label>Name <input id="m-title" value="${esc(f.title)}" maxlength="80" placeholder="e.g. Daily standup"></label>
      <div class="m-grid">
        <fieldset><legend>When</legend>
          <div class="row seg"><label><input type="radio" name="m-kind" value="schedule"${event ? '' : ' checked'}> On a schedule</label><label><input type="radio" name="m-kind" value="event"${event ? ' checked' : ''}> When an item gets a label</label></div>
          ${event ? `<label>When an item gets the label <input id="m-label" value="${esc(f.when.label)}" placeholder="e.g. design"></label><p class="hint">An issue or pull request. Label meetings start once the runner is connected.</p>`
            : `<div class="row days" role="group" aria-label="Days">${DAYS.map((d) => `<button type="button" class="day" data-day="${d}" aria-pressed="${f.when.days?.includes(d) ? 'true' : 'false'}" aria-label="${DAY_NAME[d]}">${DAY_LETTER[d]}</button>`).join('')}<input id="m-at" type="time" value="${esc(f.when.at ?? '')}" aria-label="Time"></div>
            <p class="hint">${validZone(tz) ? `Times are in ${esc(tz)}. <a href="#" id="m-tz">Change it</a>.` : `Times are in UTC because the team has no time zone yet. <a href="#" id="m-tz">Set it</a>${browserTz ? `, or <a href="#" id="m-tz-browser" data-tz="${esc(browserTz)}">use this browser's (${esc(browserTz)})</a>` : ''}.`}</p>
            <label class="switch"><input type="checkbox" id="m-skip"${f.skipIfQuiet ? ' checked' : ''}> Skip it when nothing changed since the last one</label>`}
        </fieldset>
        <label>Run by <select id="m-runner">${on.map((r) => `<option value="${esc(r.slug)}"${r.slug === f.facilitator ? ' selected' : ''}>${esc(r.title)}</option>`).join('')}</select><span class="hint">Asks each attendee, writes the minutes, files action items.</span></label>
      </div>
      <fieldset><legend>Who attends</legend>
        <div class="chips">${attendeeChips()}
          <select id="m-add" aria-label="Add roles or a whole lane"><option value="">Add roles or a whole lane</option>
            ${pickable.length ? `<optgroup label="Roles">${pickable.map((r) => `<option value="role:${esc(r.slug)}">${esc(r.title)}</option>`).join('')}</optgroup>` : ''}
            ${lanesFree.length ? `<optgroup label="Whole lanes">${lanesFree.map((r) => `<option value="lane:${esc(r.slug)}">${esc(r.title)} and everyone reporting to it</option>`).join('')}</optgroup>` : ''}
          </select></div>
        <label class="switch"><input type="checkbox" id="m-rule"${a.rule === 'worked-since-last' ? ' checked' : ''}> Also everyone who worked since the last one</label>
        ${dormantLane ? '<p class="hint warn">Dormant roles in this lane are not woken unless you name them.</p>' : ''}
      </fieldset>
      <fieldset><legend>Format</legend><div class="cards2">
        ${radio('m-format', 'round', 'Written round', 'Each attendee answers once, from its board and memory file. Cheapest; no cross-talk.', f.format !== 'discussion')}
        ${radio('m-format', 'discussion', 'Discussion', 'Attendees read each other and reply, for 2 to 5 rounds. For planning and trade-offs.', f.format === 'discussion')}
      </div>
      ${f.format === 'discussion' ? `<label class="inline">Rounds <select id="m-rounds">${[2, 3, 4, 5].map((n) => `<option${n === f.rounds ? ' selected' : ''}>${n}</option>`).join('')}</select></label><p class="hint warn">Discussion meetings run as a written round until the runner supports them.</p>` : ''}
      </fieldset>
      <label>Agenda each attendee answers <textarea id="m-agenda" rows="4">${esc(f.agenda)}</textarea></label>
      <fieldset><legend>If an attendee is in the middle of a task</legend>
        ${radio('m-busy', 'next-pause', 'Answer at its next pause', 'The question waits until its current step ends. Its work is never interrupted; a late answer goes into the minutes as an addendum.', f.ifBusy === 'next-pause' || !f.ifBusy)}
        ${radio('m-busy', 'proxy', 'Answer from its board reports', 'No wake-up and no cost. The minutes mark the answer as taken from reports.', f.ifBusy === 'proxy')}
        ${radio('m-busy', 'skip', 'Leave it out this time', 'The minutes say it was busy.', f.ifBusy === 'skip')}
      </fieldset>
      <div class="m-grid">
        <fieldset><legend>You</legend>
          <label class="switch"><input type="checkbox" id="m-minutes"${f.owner?.minutes !== false ? ' checked' : ''}> Send me the minutes</label>
          <label class="switch"><input type="checkbox" id="m-speaks"${f.owner?.speaks ? ' checked' : ''}> I join and can speak</label>
        </fieldset>
        <label>Limit per meeting <span class="money-in">$<input id="m-cap" type="number" min="0.01" step="0.01" value="${esc(f.capUsd)}"></span><span class="hint">It stops and writes partial minutes at the cap.${typeof ctx.dailyCapUsd() === 'number' ? ` The team's daily cap is ${money(ctx.dailyCapUsd())}.` : ''}</span></label>
      </div>
      <div class="row m-actions">
        ${selected !== 'new' ? '<button type="button" id="m-delete" class="danger">Delete meeting</button>' : ''}
        <span class="spacer"></span>
        <button type="button" id="m-cancel"${dirty ? '' : ' disabled'}>Discard changes</button>
        <button type="submit" class="primary" id="m-save"${dirty ? '' : ' disabled'}>Save to the draft</button>
      </div>
      ${note ? `<p class="result ok" role="status">${esc(note)}</p>` : ''}
    </form>`;
  }

  function reportsUp(slug, lane) {
    const by = new Map(ctx.team().map((r) => [r.slug, r]));
    const seen = new Set();
    for (let m = by.get(slug)?.reportsTo; m && !seen.has(m); m = by.get(m)?.reportsTo) { if (m === lane) return true; seen.add(m); }
    return false;
  }

  /** Criterion 8: what a run does, in words, from the definition only. */
  function timelineHtml() {
    const f = form;
    const who = meetingAttendees(f, ctx.resolved());
    const others = who.roles.filter((s) => s !== f.facilitator);
    const n = others.length;
    const runner = titleOf(f.facilitator) || 'The role that runs it';
    const when = f.when.label !== undefined ? `When an item gets the label "${f.when.label || '…'}"` : f.when.at ? `${meetingWhen(f.when).replace(/`/g, '')}` : 'At the time you set';
    const att = `${n} attendee${n === 1 ? '' : 's'}${who.dynamic ? ', plus everyone who worked since the last one' : ''}`;
    const busy = ({ 'next-pause': 'An attendee in the middle of a task answers when its current step ends.', proxy: 'An attendee in the middle of a task answers from its board reports, at no cost.', skip: 'An attendee in the middle of a task is left out this time.' })[f.ifBusy ?? 'next-pause'];
    const steps = [
      [when, `${runner} opens the meeting and sends the agenda to ${att}.${f.skipIfQuiet && f.when.label === undefined ? ' If nothing changed since the last one, it is skipped.' : ''}`],
      ['Then', `${f.format === 'discussion' ? `Attendees answer and reply to each other, ${f.rounds ?? 3} rounds (a written round until the runner supports discussions).` : 'Each attendee answers the agenda once.'} ${busy}`],
      ['Minutes', `${runner} writes the minutes in the chat: answers, decisions and action items.${f.owner?.minutes !== false ? ' You get them.' : ''}${f.owner?.speaks ? ' You can speak during it.' : ''}`],
      ['After', 'Action items go to their owners as tasks or hand-offs. Anything that needs you becomes a decision card.'],
    ];
    return `<ol class="timeline-steps">${steps.map(([t, d]) => `<li><span class="muted">${esc(t)}</span><span>${esc(d)}</span></li>`).join('')}</ol>`;
  }

  function estimateHtml() {
    const prices = ctx.prices();
    if (!prices) return '<p class="muted">The price table could not be read.</p>';
    const e = meetingEstimate(form, ctx.resolved(), prices);
    return `<table class="estimate"><tbody>
      <tr><td>${e.turns} turn${e.turns === 1 ? '' : 's'}, by each role's model tier</td><td></td></tr>
      <tr class="total"><td>Per meeting</td><td>${money(e.perMeetingUsd)}</td></tr>
      ${e.perMonthUsd != null ? `<tr><td>Per month</td><td>about ${money(e.perMonthUsd)}</td></tr>` : '<tr><td>Per month</td><td class="muted">depends on how often the label is added</td></tr>'}
    </tbody></table><p class="hint">Estimate, prices as of ${esc(e.asOf)}.${form.capUsd < e.perMeetingUsd ? ` The ${money(form.capUsd)} limit is below this estimate, so it may stop early.` : ''}</p>`;
  }

  function sideHtml() {
    const checks = formChecks();
    return `<h2>What happens</h2>${timelineHtml()}
      <h2>Estimate</h2>${estimateHtml()}
      <h2>Checks</h2><ul class="issues">${checks.length ? checks.map((i) => `<li class="${i.level}">${esc(i.message.replace(/^./, (c) => c.toUpperCase()))}</li>`).join('') : '<li class="none">No problems with this meeting.</li>'}</ul>
      <h2>Saved as</h2><p class="hint"><code>.agent-team/meetings.json</code>, published with the team like any other change. Minutes stay in the Studio and the chat, never in the repository.</p>`;
  }

  function render() {
    if (ctx.small()) {
      // D28: on a phone the list is read-only.
      root.innerHTML = `<div class="meetings small">${listHtml()}<p class="hint">Edit meetings on a larger screen.</p></div>`;
      return;
    }
    if (selected && selected !== 'new' && !list().some((m) => m.id === selected)) { selected = null; form = null; dirty = false; }
    if (!selected && list().length) open(list()[0].id, { quiet: true });
    root.innerHTML = `<div class="meetings">
      <aside class="m-list">${listHtml()}</aside>
      <section class="m-main" aria-label="Meeting">${form ? formHtml() : `<div class="empty-state"><h2>No meetings yet</h2><p>Define a daily standup, a weekly planning or any meeting your team should hold. Pick <strong>New meeting</strong> to start from a blank one or a starter.</p></div>`}</section>
      <aside class="m-side" aria-label="What happens and the estimate">${form ? sideHtml() : ''}</aside>
    </div>`;
  }
  /** Redraws the side column and the buttons while typing, without touching the field that has focus. */
  function refresh() {
    if (!form) return;
    const side = root.querySelector('.m-side');
    if (side) side.innerHTML = sideHtml();
    for (const id of ['m-save', 'm-cancel']) { const b = root.querySelector(`#${id}`); if (b) b.disabled = !dirty; }
  }

  function open(id, { quiet = false } = {}) {
    const m = list().find((x) => x.id === id);
    if (!m) return;
    selected = id;
    autoCap = false;
    form = { ...structuredClone(m), attendees: { roles: [], lanes: [], rule: null, ...structuredClone(m.attendees ?? {}) }, owner: { minutes: true, speaks: false, ...(m.owner ?? {}) } };
    dirty = false;
    note = '';
    if (!quiet) render();
  }

  /** A new meeting's limit starts at its estimate rounded up to the next dollar, at least $1. */
  function fitCap() {
    const prices = ctx.prices();
    if (!autoCap || !form || !prices) return;
    form.capUsd = Math.max(1, Math.ceil(meetingEstimate(form, ctx.resolved(), prices).perMeetingUsd));
    const input = root.querySelector('#m-cap');
    if (input) input.value = String(form.capUsd);
  }

  function edit(fn, { redraw = false } = {}) {
    fn(form);
    fitCap();
    dirty = true;
    note = '';
    if (redraw) render(); else refresh();
  }

  function save() {
    const f = structuredClone(form);
    if (!f.title.trim()) { note = 'Give the meeting a title first.'; return render(); }
    if (selected === 'new' && !idPattern.test(f.id)) f.id = slugify(f.title);
    if (f.format !== 'discussion') f.rounds = 1;
    if (!f.attendees.rule) f.attendees.rule = null;
    ctx.change((spec) => {
      spec.meetings ??= { meetings: [] };
      spec.meetings.meetings ??= [];
      const i = spec.meetings.meetings.findIndex((m) => m.id === (selected === 'new' ? f.id : selected));
      if (i >= 0) spec.meetings.meetings[i] = f; else spec.meetings.meetings.push(f);
    });
    selected = f.id;
    form = structuredClone(f);
    dirty = false;
    note = 'Saved to the draft. Publish writes it to the team.';
    render();
  }

  // ---------------------------------------------------------------- events

  root.addEventListener('click', (e) => {
    const b = e.target.closest('button, a');
    if (!b) return;
    if (b.dataset.meeting) { if (dirty && !confirm('Discard the changes to this meeting?')) return; return open(b.dataset.meeting); }
    if (b.dataset.starter) {
      if (dirty && !confirm('Discard the changes to this meeting?')) return;
      b.closest('details')?.removeAttribute('open');
      selected = 'new'; form = fresh(b.dataset.starter === 'blank' ? null : b.dataset.starter); autoCap = true; fitCap(); dirty = true; note = '';
      render();
      root.querySelector('#m-title')?.focus();
      return;
    }
    if (b.dataset.day) { e.preventDefault(); return edit((f) => { const d = new Set(f.when.days ?? []); d.has(b.dataset.day) ? d.delete(b.dataset.day) : d.add(b.dataset.day); f.when.days = DAYS.filter((x) => d.has(x)); }, { redraw: true }); }
    if (b.dataset.removeRole) return edit((f) => { f.attendees.roles = f.attendees.roles.filter((s) => s !== b.dataset.removeRole); }, { redraw: true });
    if (b.dataset.removeLane) return edit((f) => { f.attendees.lanes = f.attendees.lanes.filter((s) => s !== b.dataset.removeLane); }, { redraw: true });
    if (b.id === 'm-cancel') { if (selected === 'new') { selected = null; form = null; dirty = false; return render(); } return open(selected); }
    if (b.id === 'm-delete') {
      if (!confirm(`Delete "${form.title || selected}"? It leaves the draft; Publish removes it from the team.`)) return;
      const id = selected;
      ctx.change((spec) => { spec.meetings.meetings = spec.meetings.meetings.filter((m) => m.id !== id); });
      selected = null; form = null; dirty = false;
      return render();
    }
    if (b.id === 'm-tz') { e.preventDefault(); const z = prompt('The team\'s time zone (an IANA name such as Europe/Lisbon or America/New_York):', ctx.timezone()); if (z && validZone(z)) { ctx.change((spec) => { spec.values = { ...(spec.values ?? {}), TIMEZONE: z }; }); render(); } else if (z) alert(`"${z}" is not a time zone this browser knows.`); return; }
    if (b.id === 'm-tz-browser') { e.preventDefault(); ctx.change((spec) => { spec.values = { ...(spec.values ?? {}), TIMEZONE: b.dataset.tz }; }); return render(); }
  });
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (!form) return;
    if (t.id === 'm-title') return edit((f) => { f.title = t.value; if (selected === 'new') f.id = uniqueId(slugify(t.value)); });
    if (t.id === 'm-agenda') return edit((f) => { f.agenda = t.value; });
    if (t.id === 'm-label') return edit((f) => { f.when = { label: t.value }; });
    if (t.id === 'm-at') return edit((f) => { f.when.at = t.value; });
    if (t.id === 'm-cap') { autoCap = false; return edit((f) => { f.capUsd = Number(t.value); }); }
  });
  root.addEventListener('change', (e) => {
    const t = e.target;
    if (!form) return;
    if (t.name === 'm-kind') return edit((f) => { f.when = t.value === 'event' ? { label: '' } : { days: WEEKDAYS, at: '09:00' }; }, { redraw: true });
    if (t.name === 'm-format') return edit((f) => { f.format = t.value; f.rounds = t.value === 'discussion' ? 3 : 1; }, { redraw: true });
    if (t.name === 'm-busy') return edit((f) => { f.ifBusy = t.value; }, { redraw: true });
    if (t.id === 'm-rounds') return edit((f) => { f.rounds = Number(t.value); });
    if (t.id === 'm-runner') return edit((f) => { f.facilitator = t.value; f.attendees.roles = f.attendees.roles.filter((s) => s !== t.value); }, { redraw: true });
    if (t.id === 'm-skip') return edit((f) => { f.skipIfQuiet = t.checked; });
    if (t.id === 'm-rule') return edit((f) => { f.attendees.rule = t.checked ? 'worked-since-last' : null; }, { redraw: true });
    if (t.id === 'm-minutes') return edit((f) => { f.owner = { ...f.owner, minutes: t.checked }; });
    if (t.id === 'm-speaks') return edit((f) => { f.owner = { ...f.owner, speaks: t.checked }; });
    if (t.id === 'm-add' && t.value) {
      const [kind, slug] = t.value.split(':');
      return edit((f) => { const k = kind === 'lane' ? 'lanes' : 'roles'; f.attendees[k] = [...(f.attendees[k] ?? []), slug]; }, { redraw: true });
    }
  });
  root.addEventListener('submit', (e) => { e.preventDefault(); save(); });

  function uniqueId(base) {
    const taken = new Set(list().map((m) => m.id));
    let id = base; for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  }
  function validZone(z) { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } }

  return {
    render,
    /** True while a meeting has unsaved edits (the page asks before leaving). */
    get dirty() { return dirty; },
  };
}
