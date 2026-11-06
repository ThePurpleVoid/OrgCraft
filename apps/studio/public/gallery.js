// The template gallery (templates story, criteria 5 to 8; D31 to D34): what the Studio shows in a repository that
// has no team yet. Cards are grouped without jargon and searchable; picking one previews it on the real canvas
// (app.js), and nothing is written until "Use this template" and then Publish.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** "4 roles on · 2 dormant" */
export function rolesLine(card) {
  const d = card.dormant?.length ?? 0;
  return `${card.on} role${card.on === 1 ? '' : 's'} on${d ? ` · ${d} dormant` : ''}`;
}

/** What each pack of shared rules adds to the core, in plain words (neutral protocols story, criterion 5). */
export const PACK_WORDS = { engineering: 'engineering (pull requests, the merge gate, deploys)' };

/** "Shared rules: the core and engineering (…)", or "the core only" for a team with no packs. */
export function rulesLine(packs) {
  const list = (packs ?? []).map((p) => PACK_WORDS[p] ?? p);
  return `Shared rules: ${list.length ? `the core and ${list.join(', ')}` : 'the core only'}`;
}

/** Whether a card matches the search box: its title, summary, group, suggested systems, starter meetings or roles. */
export function matches(card, q) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const text = [card.title, card.summary, card.groupTitle, ...(card.systems ?? []).map((s) => s.name), ...(card.meetings ?? []).map((m) => m.title), ...(card.roles ?? []).map((r) => r.replace(/-/g, ' '))].join(' ').toLowerCase();
  return words.every((w) => text.includes(w));
}

/**
 * root: the gallery's section. ctx: cards() (the kit's template cards), groups() (group id → title, in order),
 * onPick(id) (preview a template), onAlmostEmpty().
 */
export function createGallery({ root, ctx }) {
  let q = '';

  function cardHtml(c) {
    const systems = (c.systems ?? []).map((s) => s.name);
    return `<li><button type="button" class="g-card" data-template="${esc(c.id)}">
      <strong>${esc(c.title)}</strong>
      <span class="g-summary">${esc(c.summary)}</span>
      <span class="muted">${esc(rolesLine(c))}</span>
      <span class="muted">${esc(rulesLine(c.packs))}</span>
      ${systems.length ? `<span class="muted">Suggests ${esc(systems.join(', '))}</span>` : ''}
    </button></li>`;
  }

  function listHtml() {
    const cards = ctx.cards().filter((c) => matches(c, q));
    if (!cards.length) return `<p class="muted">No starting team matches "${esc(q)}".</p>`;
    const groups = Object.entries(ctx.groups());
    const known = new Set(groups.map(([id]) => id));
    const other = cards.filter((c) => !known.has(c.group));
    return [...groups.map(([id, title]) => [title, cards.filter((c) => c.group === id)]), ['Other', other]]
      .filter(([, list]) => list.length)
      .map(([title, list]) => `<section class="g-group"><h2>${esc(title)}</h2><ul class="g-cards">${list.map(cardHtml).join('')}</ul></section>`).join('');
  }

  function render() {
    root.innerHTML = `<div class="gallery">
      <div class="g-head">
        <div><h1>Start a team</h1>
        <p class="hint">This repository has no team yet. Pick a starting team and look it over; you can change anything before it is written to the repository.</p></div>
        <input id="g-search" type="search" placeholder="Search starting teams" aria-label="Search starting teams" value="${esc(q)}">
      </div>
      <div id="g-list">${listHtml()}</div>
      <section class="g-group g-other"><h2>Or</h2>
        <p><button type="button" id="g-empty">Start almost empty</button> <span class="hint">A chief of staff only. Add roles from the library.</span></p>
        <p class="hint">To open a team that already exists, start the Studio in that repository: <code>npx agent-team studio</code>.</p>
      </section>
    </div>`;
  }

  root.addEventListener('input', (e) => {
    if (e.target.id !== 'g-search') return;
    q = e.target.value;
    root.querySelector('#g-list').innerHTML = listHtml();
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.template) return ctx.onPick(b.dataset.template);
    if (b.id === 'g-empty') return ctx.onAlmostEmpty();
  });

  return { render };
}
