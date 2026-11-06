// The chat with the chief of staff (PRD 6.4, C1 to C4; clients contract sections 5 to 7). Plain ES module, no build.
// What it shows comes from the control plane as events and cards, never as HTML: the owner's words exactly as typed,
// the team's replies in a small Markdown subset, cards built from their fields, today's cost against the cap, and
// pause and stop for the run. The Studio server holds the token; this page only talks to it.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const human = (slug) => { const s = String(slug ?? '').replace(/[-_]+/g, ' ').trim(); return s ? s[0].toUpperCase() + s.slice(1) : 'Someone'; };
/** A ULID: what the contract asks clients to use for a message's clientId (sortable, unique without a server). */
export function ulid(now = Date.now()) {
  const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let t = '', n = now;
  for (let i = 0; i < 10; i++) { t = A[n % 32] + t; n = Math.floor(n / 32); }
  const r = crypto.getRandomValues(new Uint8Array(16));
  return t + Array.from(r, (b) => A[b % 32]).join('');
}
const newId = () => ulid();
/** Names for the link relations cards use most; any other relation shows as its own words. */
const LINKS = { pr: 'Pull request', preview: 'Preview', evidence: 'Evidence', issue: 'Issue', log: 'Log', diff: 'Changes' };
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? String(u) : null);

/** The Markdown subset cards and replies may use: paragraphs, lists, emphasis, code and http(s) links. No HTML. */
export function md(text) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => { const u = safeUrl(url.replace(/&amp;/g, '&')); return u ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label; });
  const isItem = (l) => /^\s*([-*]|\d+\.)\s+/.test(l);
  return String(text ?? '').trim().split(/\n{2,}/).map((block) => {
    // Runs of list lines become a list; other lines stay a paragraph with line breaks.
    const out = [];
    for (const line of block.split('\n')) {
      const kind = isItem(line) ? (/^\s*\d+\./.test(line) ? 'ol' : 'ul') : 'p';
      if (out.at(-1)?.kind === kind) out.at(-1).lines.push(line); else out.push({ kind, lines: [line] });
    }
    return out.map(({ kind, lines }) => (kind === 'p' ? `<p>${lines.map(inline).join('<br>')}</p>`
      : `<${kind}>${lines.map((l) => `<li>${inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`).join('')}</${kind}>`)).join('');
  }).join('');
}

const fmtTime = (iso) => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
const fmtMoney = (minor, currency) => {
  if (typeof minor !== 'number') return '';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(minor / 100); } catch { return `${(minor / 100).toFixed(2)} ${currency ?? ''}`.trim(); }
};

/** Who said it: the owner (a person) or a role. */
function speaker(e) {
  const from = e.data?.from;
  const kind = (typeof from === 'object' ? from?.kind : null) ?? e.actor?.kind;
  const id = (typeof from === 'object' ? from?.id : from) ?? e.actor?.id;
  return kind === 'person' || kind === 'member' ? { me: true, name: 'You' } : { me: false, name: human(id) };
}

const by = (e) => { const b = e.data?.by; const n = typeof b === 'object' ? b?.name ?? b?.id : b; return n ? ` by ${n}` : ''; };
/** Run and budget events, as one line each in the chat. */
const TIMELINE = {
  'run.started': (e) => `The team started a run${by(e)}`,
  'run.paused': (e) => `The run was paused${by(e)}${e.data?.reason ? `: ${e.data.reason}` : ''}`,
  'run.resumed': (e) => `The run resumed${by(e)}`,
  'run.stopped': (e) => `The run stopped${by(e)}${e.data?.reason ? `: ${e.data.reason}` : ''}`,
  'budget.warned': () => 'Most of today\'s budget is spent',
  'budget.exhausted': () => 'Today\'s budget is spent, so the team is paused',
};
const subjectId = (subject) => String(subject ?? '').split('/').slice(1).join('/');

/** A card from its event. Cards the control plane sends whole (data.card, or the response's cards) win. */
function cardFrom(e) {
  if (e.data?.card && typeof e.data.card === 'object') return e.data.card;
  const d = { ...(e.data ?? {}), ...(typeof e.data?.card === 'string' ? { cardId: e.data.card } : {}) };
  if (e.type === 'approval.requested') {
    return {
      id: d.cardId || subjectId(e.subject) || e.id, kind: 'approval', subject: e.subject, version: d.version ?? 1,
      title: d.title ?? d.action ?? 'Approval needed', body: d.why ?? '', risk: d.risk, expires: d.expires,
      recommendation: d.recommendation,
      options: [{ id: 'approve', label: 'Approve', style: 'primary', stepUp: true }, { id: 'deny', label: 'Deny', style: 'danger' }],
    };
  }
  const opts = (d.options ?? []).map((o) => (typeof o === 'string' ? { id: o, label: o } : o));
  const rec = typeof d.recommended === 'string' ? { option: d.recommended, why: d.why } : d.recommendation;
  return { id: d.cardId || subjectId(e.subject) || e.id, kind: 'decision', subject: e.subject, version: d.version ?? 1, title: d.question ?? d.title ?? 'A decision', body: d.body ?? '', options: opts, recommendation: rec };
}

export function createChat({ root, onOpen } = {}) {
  const st = {
    connected: null, error: null, events: [], next: null, cards: new Map(), answers: new Map(), pending: [],
    notes: new Map(), // card id -> note shown above it (changed, step-up)
    run: null, cost: null, summary: null, busy: false, loaded: false, es: null, team: null,
    older: [], local: new Set(), // pages fetched with 'Show earlier'; events this page posted

  };

  root.innerHTML = `
    <div class="chat-head">
      <div class="chat-title"><strong>Chief of staff</strong> <span id="chat-where" class="muted"></span></div>
      <div class="chat-run row">
        <span id="run-state" class="pill" role="status"></span>
        <span id="cost" class="cost" role="status"></span>
        <button id="run-pause" type="button"></button>
        <button id="run-stop" type="button" class="danger">Stop</button>
      </div>
    </div>
    <div id="chat-log" class="chat-log" aria-live="polite" aria-label="Chat with the chief of staff"></div>
    <form id="chat-form" class="chat-form">
      <textarea id="chat-text" rows="1" placeholder="Message the chief of staff" aria-label="Message the chief of staff"></textarea>
      <button type="submit" class="primary" id="chat-send">Send</button>
    </form>`;

  const log = $('#chat-log', root);
  const text = $('#chat-text', root);

  async function api(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    return { ok: res.ok, status: res.status, data };
  }

  function cardHtml(card, answered) {
    const note = st.notes.get(card.id);
    const rec = card.recommendation?.option;
    const recLabel = rec && (card.options ?? []).find((o) => o.id === rec)?.label;
    const known = ['approval', 'decision'].includes(card.kind);
    const buttons = answered ? '' : (card.options ?? []).map((o) => {
      const style = ['primary', 'danger'].includes(o.style) ? o.style : rec === o.id ? 'primary' : '';
      return `<button type="button" class="${style}" data-card="${esc(card.id)}" data-option="${esc(o.id)}">${esc(o.label ?? o.id)}</button>`;
    }).join('');
    const links = (card.links ?? []).map((l) => safeUrl(l.url) && `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title ?? LINKS[l.rel] ?? human(l.rel ?? 'link'))}</a>`).filter(Boolean).join(' · ');
    return `<article class="card-msg k-${known ? esc(card.kind) : 'other'}${answered ? ' answered' : ''}" data-card-id="${esc(card.id)}">
      <div class="card-meta muted">${esc(human(card.kind))}${recLabel ? ` · recommended: ${esc(recLabel)}` : ''}${card.risk ? ` · risk ${esc(card.risk)}` : ''}${card.expires && !answered ? ` · until ${esc(fmtTime(card.expires))}` : ''}</div>
      ${note ? `<p class="card-note ${note.kind}" role="alert">${esc(note.text)}</p>` : ''}
      ${note?.kind === 'stepup' && !answered ? `<form class="stepup row" data-stepup="${esc(card.id)}" data-option="${esc(note.option)}"><input type="password" autocomplete="current-password" aria-label="Admin token" placeholder="Admin token" required><button type="submit" class="primary">Confirm</button></form>` : ''}
      <h3>${esc(card.title)}</h3>
      ${card.body ? `<div class="md">${md(card.body)}</div>` : ''}
      ${card.recommendation?.why && !answered ? `<p class="muted why">${esc(card.recommendation.why)}</p>` : ''}
      ${links ? `<p class="links">${links}</p>` : ''}
      ${answered ? `<p class="answer">${esc(answered)}</p>` : `<div class="card-actions">${buttons}</div>`}
    </article>`;
  }

  function answerText(e, card) {
    const d = e.data ?? {};
    const by = d.by ? (typeof d.by === 'object' ? d.by.name ?? d.by.id : d.by) : e.actor?.kind === 'person' ? 'you' : human(e.actor?.id);
    const what = String(d.decision ?? d.answer ?? d.option ?? 'answered');
    const label = (card?.options ?? []).find((o) => o.id === what || (o.id === 'approve' && what === 'approved') || (o.id === 'deny' && what === 'denied'))?.label;
    return `${label ?? human(what)}${by ? ` · ${by}` : ''}${e.time ? ` at ${fmtTime(e.time)}` : ''}${d.note ? `: ${d.note}` : ''}`;
  }

  function render() {
    if (st.connected === false) {
      log.innerHTML = `<div class="chat-empty"><p><strong>No control plane connected.</strong></p><p class="muted">The chat talks to your team's chief of staff through the control plane. Start the Studio with <code>AGENT_TEAM_SERVER</code>, <code>AGENT_TEAM_SERVER_TOKEN</code> and <code>AGENT_TEAM_SERVER_TEAM</code> set, as for the live board.</p></div>`;
      text.disabled = true; $('#chat-send', root).disabled = true;
      renderRun();
      return;
    }
    text.disabled = false; $('#chat-send', root).disabled = false;
    const answered = new Map(); // subject -> the answer event
    for (const e of st.events) {
      if (!/^(decision\.answered|approval\.decided)$/.test(e.type)) continue;
      if (e.subject) answered.set(e.subject, e);
      if (typeof e.data?.card === 'string') answered.set(e.data.card, e);
    }
    const seen = new Set();
    let html = st.next ? '<p class="older"><button type="button" id="chat-older">Show earlier messages</button></p>' : '';
    if (!st.loaded) html += '<p class="muted chat-empty">Loading the chat…</p>';
    else if (!st.events.length && !st.pending.length) html += '<div class="chat-empty"><p class="muted">Ask the chief of staff for something, as you would ask a colleague. Your words reach the team exactly as you type them.</p></div>';
    for (const e of st.events) {
      if (e.type === 'chat.message') {
        const who = speaker(e);
        seen.add(e.data?.clientId);
        html += `<div class="msg ${who.me ? 'me' : 'them'}" id="m-${esc(e.id)}"><div class="who muted">${esc(who.name)} · <time datetime="${esc(e.time)}">${esc(fmtTime(e.time))}</time></div>
          <div class="bubble">${who.me ? `<p class="verbatim">${esc(e.data?.text)}</p>` : `<div class="md">${md(e.data?.text)}</div>`}</div></div>`;
      } else if (e.type === 'decision.requested' || e.type === 'approval.requested') {
        const base = cardFrom(e);
        const card = st.cards.get(base.id) ?? base;
        html += `<div class="msg them"><div class="who muted">${esc(human(e.actor?.id))} · ${esc(fmtTime(e.time))}</div>${cardHtml(card, (() => { const a = answered.get(card.id) ?? answered.get(e.subject ?? card.subject); return a ? answerText(a, card) : st.answers.get(card.id); })())}</div>`;
      } else if (/^(decision\.answered|approval\.decided|card\.updated|usage\.recorded)$/.test(e.type)) {
        // shown on its card, or in the cost line
      } else if (TIMELINE[e.type]) {
        html += `<p class="timeline muted">${esc(TIMELINE[e.type](e))} · ${esc(fmtTime(e.time))}</p>`;
      } else {
        html += `<p class="timeline muted">${esc(human(e.actor?.id))} · ${esc(e.type)} · ${esc(fmtTime(e.time))}</p>`;
      }
    }
    for (const p of st.pending) {
      if (seen.has(p.clientId)) continue;
      html += `<div class="msg me pending"><div class="bubble"><p class="verbatim">${esc(p.text)}</p></div><div class="who muted">${p.failed ? `Not sent: ${esc(p.failed)} <button type="button" class="link" data-retry="${esc(p.clientId)}">Try again</button>` : 'Sending…'}</div></div>`;
    }
    st.pending = st.pending.filter((p) => !seen.has(p.clientId));
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.innerHTML = html + (st.error ? `<p class="result error">${esc(st.error)}</p>` : '');
    if (atBottom) log.scrollTop = log.scrollHeight;
    renderRun();
  }

  function renderRun() {
    const s = st.summary, state = st.run?.state ?? s?.run ?? null;
    const c = st.cost ?? s?.cost;
    $('#chat-where', root).textContent = st.team ? `· ${st.team}` : '';
    const pill = $('#run-state', root);
    pill.textContent = state ? human(state) : st.connected === false ? 'Not connected' : 'Not running';
    pill.className = `pill ${state === 'running' ? 'ok' : state === 'paused' ? 'warn' : ''}`;
    const cost = $('#cost', root);
    if (c && typeof c.today === 'number') {
      const pct = c.capPerDay ? Math.min(100, Math.round((c.today / c.capPerDay) * 100)) : null;
      cost.innerHTML = `Today ${esc(fmtMoney(c.today, c.currency))}${c.capPerDay ? ` of ${esc(fmtMoney(c.capPerDay, c.currency))}` : ', no daily cap'}${pct !== null ? `<span class="meter${pct >= 80 ? ' high' : ''}" aria-hidden="true"><span style="width:${pct}%"></span></span>` : ''}`;
      cost.title = c.capPerDay ? `${pct}% of today's cap${c.state === 'exhausted' ? ': the cap is reached' : ''}` : '';
      cost.classList.toggle('over', c.state === 'exhausted');
    } else cost.textContent = '';
    const pause = $('#run-pause', root);
    pause.textContent = state === 'paused' ? 'Resume' : 'Pause';
    pause.disabled = st.busy || !(state === 'running' || state === 'paused');
    $('#run-stop', root).disabled = st.busy || !(state === 'running' || state === 'paused');
  }

  async function load() {
    const r = await api('/v1/team/chat');
    st.loaded = true;
    if (r.data.connected === false) { st.connected = false; return render(); }
    st.connected = true;
    if (!r.ok) { st.error = r.data.error ?? `HTTP ${r.status}`; return render(); }
    st.error = null;
    st.team = r.data.team;
    const latest = r.data.items ?? r.data.events ?? [];
    const ids = new Set(latest.map((e) => e.id));
    // Messages sent from this page that the page has not seen in a fetch yet stay until it does.
    const mine = st.events.filter((e) => !ids.has(e.id) && !st.older.some((o) => o.id === e.id) && st.local.has(e.id));
    st.events = [...st.older.filter((e) => !ids.has(e.id)), ...latest, ...mine];
    if (!st.older.length) st.next = r.data.next ?? null;
    takeCards(Array.isArray(r.data.cards) ? r.data.cards : Object.values(r.data.cards ?? {}));
    takeCards(st.events.filter((e) => e.type === 'card.updated').map((e) => e.data?.card));
    if ('run' in r.data || 'cost' in r.data) { st.run = r.data.run ?? null; st.cost = r.data.cost ?? null; render(); }
    else { render(); loadRun(); }
  }

  /** Keeps the newest version of each card (card.updated carries the whole card). */
  function takeCards(list) {
    for (const c of list) if (c?.id && (!st.cards.has(c.id) || (st.cards.get(c.id).version ?? 0) <= (c.version ?? 0))) st.cards.set(c.id, c);
  }

  async function loadOlder() {
    const r = await api(`/v1/team/chat?before=${encodeURIComponent(st.next)}`);
    if (!r.ok) return;
    const page = (r.data.items ?? r.data.events ?? []).filter((e) => !st.events.some((x) => x.id === e.id));
    st.older = [...page, ...st.older];
    st.events = [...page, ...st.events];
    st.next = r.data.next ?? null;
    render();
  }

  async function loadRun() {
    const r = await api('/v1/team/run');
    if (r.ok && r.data.connected) { st.summary = r.data.summary; st.run = r.data.run; }
    renderRun();
  }

  async function send(p) {
    p.failed = null;
    render();
    const r = await api('/v1/team/chat', { text: p.text, clientId: p.clientId });
    if (!r.ok) p.failed = r.data.error ?? `HTTP ${r.status}`;
    else if (r.data?.type === 'chat.message' && !st.events.some((e) => e.id === r.data.id)) { st.local.add(r.data.id); st.events.push(r.data); }
    render();
  }

  async function answer(cardId, option, secret) {
    const ev = st.events.find((e) => /\.requested$/.test(e.type) && cardFrom(e).id === cardId);
    const card = st.cards.get(cardId) ?? (ev && cardFrom(ev));
    if (!card) return;
    st.notes.delete(cardId);
    for (const b of log.querySelectorAll(`[data-card="${CSS.escape(cardId)}"]`)) b.disabled = true;
    if (secret) {
      const su = await api('/v1/team/step-up', { secret });
      if (!su.ok) { st.notes.set(cardId, { kind: 'stepup', option, text: su.status === 401 ? 'That token was not accepted. Try again.' : su.data.error ?? `HTTP ${su.status}` }); return render(); }
    }
    const r = await api(`/v1/team/cards/${encodeURIComponent(cardId)}`, { kind: card.kind, subject: card.subject ?? ev?.subject, option, version: card.version, key: newId() });
    if (r.status === 409 && r.data.card) {
      // Someone or something changed the card first. Show what it says now; nobody approves what they did not see.
      st.cards.set(cardId, r.data.card);
      st.notes.set(cardId, { kind: 'changed', text: 'This card changed before your answer arrived, so nothing was sent. Here is what it says now; answer again if it still applies.' });
    } else if (r.status === 401 && r.data.type === 'step-up-required') {
      // Until sign-in lands (M4), the proof is the admin token typed again; the Studio server keeps the step-up token.
      st.notes.set(cardId, { kind: 'stepup', option, text: 'Confirm it is you: type the admin token to answer. It is checked by the control plane and not stored in this page.' });
    } else if (!r.ok) {
      st.notes.set(cardId, { kind: 'error', text: r.data.error ?? `HTTP ${r.status}` });
    } else {
      const label = (card.options ?? []).find((o) => o.id === option)?.label ?? option;
      st.answers.set(cardId, `${label} · you`);
      if (r.data?.type && r.data.id && !st.events.some((e) => e.id === r.data.id)) { st.local.add(r.data.id); st.events.push(r.data); }
    }
    render();
  }

  async function control(action) {
    if (action === 'stop' && !confirm('Stop the run? Every role session stops after its current step. You can start a new run later.')) return;
    st.busy = true; renderRun();
    const r = await api(`/v1/team/run/${action}`, { key: newId(), run: st.run?.id });
    st.busy = false;
    if (!r.ok) st.error = r.data.error ?? `HTTP ${r.status}`;
    await load();
  }

  $('#chat-form', root).addEventListener('submit', (e) => {
    e.preventDefault();
    if (!text.value.trim()) return;
    const p = { clientId: newId(), text: text.value };
    st.pending.push(p);
    text.value = '';
    text.style.height = '';
    send(p);
  });
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form', root).requestSubmit(); } });
  text.addEventListener('input', () => { text.style.height = ''; text.style.height = `${Math.min(text.scrollHeight, 200)}px`; });
  log.addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-stepup]');
    if (!f) return;
    e.preventDefault();
    const secret = f.querySelector('input').value;
    f.querySelector('input').value = '';
    answer(f.dataset.stepup, f.dataset.option, secret);
  });
  log.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.id === 'chat-older') return loadOlder();
    if (b.dataset.retry) { const p = st.pending.find((x) => x.clientId === b.dataset.retry); if (p) send(p); return; }
    if (b.dataset.card) answer(b.dataset.card, b.dataset.option);
  });
  $('#run-pause', root).onclick = () => control(st.run?.state === 'paused' || st.summary?.run === 'paused' ? 'resume' : 'pause');
  $('#run-stop', root).onclick = () => control('stop');

  return {
    /** Starts loading and listening the first time the chat is shown. */
    open() {
      if (st.es) return;
      load();
      st.es = new EventSource('/v1/team/board/stream');
      let t = null;
      st.es.addEventListener('changed', () => { clearTimeout(t); t = setTimeout(load, 100); });
      onOpen?.();
      setTimeout(() => text.focus({ preventScroll: true }), 0);
    },
  };
}
