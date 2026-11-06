// Where the Studio runs, and the one way it talks to its API (docs/specs/studio-embed.md section 4). The local Studio
// (agent-team studio) and a Studio mounted in a host's own admin page share every screen; only this differs:
//
//   api        the API base: '' locally, the host's mount path when embedded (for example /api/agent-team/studio).
//              Every request goes to `${api}/v1/…`, same origin, with the host's cookies.
//   headers    async () => ({ … }): the host's own auth headers, for example a bearer token. Called per request.
//   features   { publish, chat, runs, live }: what this Studio shows. Embedded step 1 has publish only.
//   embedded   true inside a host page: no launch token, no sign-in pages, no page-wide listeners or styles.
//   urlState   false (the default when embedded): the page is kept in memory and onNavigate(page) is called; the
//              Studio never reads or writes location or history.
//   root       the element the Studio lives in. Every lookup and every piece of page state is on it, never on body.
//
// The x-agent-team-studio header goes on every request (the handler refuses a request without it, E2).

export const STUDIO_HEADER = 'x-agent-team-studio';

export const env = {
  api: '',
  headers: async () => ({}),
  features: { publish: true, chat: true, runs: true, live: true },
  embedded: false,
  urlState: true,
  onNavigate: null,
  root: null,
};

/** Sets where the Studio runs. Unknown keys are ignored; features merge over the defaults. */
export function configure(opts = {}) {
  if (typeof opts.api === 'string') env.api = opts.api.replace(/\/+$/, '');
  if (typeof opts.headers === 'function') env.headers = opts.headers;
  if (opts.features && typeof opts.features === 'object') env.features = { ...env.features, ...opts.features };
  if ('embedded' in opts) env.embedded = !!opts.embedded;
  env.urlState = 'urlState' in opts ? !!opts.urlState : !env.embedded;
  env.onNavigate = typeof opts.onNavigate === 'function' ? opts.onNavigate : null;
  if (opts.root) env.root = opts.root;
  return env;
}

/** The URL of an API path ('/v1/team/…'), under the configured base. */
export const apiUrl = (path) => `${env.api}${path}`;

/** fetch() for the Studio's API: the base, the host's headers, the Studio header, same-origin credentials. */
export async function request(path, init = {}) {
  let extra = {};
  try { extra = (await env.headers()) ?? {}; } catch (e) { throw new Error(`the host page could not give its sign-in: ${e.message}`); }
  const headers = { ...extra, ...(init.headers ?? {}), [STUDIO_HEADER]: '1' };
  return fetch(apiUrl(path), { ...init, headers, credentials: 'same-origin' });
}

/** A JSON POST (or a GET when body is undefined) through request(). */
export function requestJson(path, body) {
  return body === undefined ? request(path) : request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** A feature is on when the host allowed it and the server offers it (a server that does not say offers it). */
export const feature = (name, server) => env.features[name] !== false && server?.[name] !== false;

/** Lookups inside the Studio's root only, so a host page's own #ids never collide with the Studio's. */
export const $ = (s) => env.root.querySelector(s);
export const $$ = (s) => [...env.root.querySelectorAll(s)];

/** The element whose state attributes (data-page, data-mode, small, editing…) the stylesheet reads. */
export const stateEl = () => env.root;

/**
 * The colour a dot or a card takes, set through the DOM (style-src 'self' allows CSSOM, not style="" in markup).
 * Markup carries data-paint="<css colour>"; this paints every one under el.
 */
export function paint(el = env.root) {
  for (const n of el.querySelectorAll('[data-paint]')) { n.style.background = n.dataset.paint; n.removeAttribute('data-paint'); }
}

// ------------------------------------------------------------------------------------------------ dialogs

const escText = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The Studio's own confirm, prompt and alert: a <dialog> in the root, opened with showModal(), so nothing blocks the
 * host page and a strict CSP needs nothing extra. Resolves true/false (confirm), the text or null (prompt), or
 * undefined (alert).
 */
function dialog({ text, ok = 'OK', cancel = 'Cancel', input = null, danger = false }) {
  const dlg = document.createElement('dialog');
  dlg.className = 'ask-dialog';
  dlg.setAttribute('aria-label', String(text).slice(0, 120));
  dlg.innerHTML = `<form method="dialog" class="dialog">
    <p class="ask-text"></p>
    ${input !== null ? '<label class="ask-label"><input name="answer" autocomplete="off"></label>' : ''}
    <div class="dialog-actions">
      ${cancel ? `<button type="submit" value="cancel">${escText(cancel)}</button>` : ''}
      <button type="submit" value="ok" class="${danger ? 'primary danger' : 'primary'}">${escText(ok)}</button>
    </div>
  </form>`;
  dlg.querySelector('.ask-text').textContent = text;
  const field = dlg.querySelector('input[name="answer"]');
  if (field) { field.value = input; field.setAttribute('aria-label', String(text).slice(0, 120)); }
  (env.root ?? document.body).append(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener('close', () => {
      const yes = dlg.returnValue === 'ok';
      dlg.remove();
      resolve(input !== null ? (yes ? field.value : null) : cancel ? yes : undefined);
    }, { once: true });
    dlg.showModal();
    (field ?? dlg.querySelector('button[value="ok"]')).focus();
    field?.select();
  });
}

/** confirm(): true when the person chose ok. */
export const ask = (text, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) => dialog({ text, ok, cancel, danger });
/** prompt(): the answer, or null. */
export const askText = (text, value = '') => dialog({ text, input: String(value ?? '') });
/** alert(). */
export const tell = (text) => dialog({ text, cancel: null });
