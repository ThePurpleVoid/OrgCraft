// Tooltips (ALL-4): any element with `data-tip` shows its text on hover after 400 ms, at once on keyboard focus, and
// on tapping an ⓘ button (`button.info[data-tip]`). One tooltip element for the whole Studio, `role="tooltip"`; the
// element it describes points at it with aria-describedby while it shows. Esc hides it.
// First-time hints (`[data-hint-once]`) show once per browser and can be dismissed (rule 12).
import { t } from './i18n.js';

const DELAY_MS = 400;
const ID = 'ats-tip';

/** Installs the tooltip on `root`. Listeners go with `signal`. */
export function installTips(root, signal) {
  const box = document.createElement('div');
  box.id = ID;
  box.className = 'ats-tip';
  box.setAttribute('role', 'tooltip');
  box.hidden = true;
  root.append(box);
  let timer = 0;
  let owner = null;

  const hide = () => {
    clearTimeout(timer);
    if (owner) {
      const ids = (owner.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((x) => x && x !== ID);
      if (ids.length) owner.setAttribute('aria-describedby', ids.join(' ')); else owner.removeAttribute('aria-describedby');
    }
    owner = null;
    box.hidden = true;
  };
  const show = (el) => {
    const text = el.dataset.tip;
    if (!text) return;
    hide();
    owner = el;
    box.textContent = text;
    box.hidden = false;
    const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    if (!ids.includes(ID)) el.setAttribute('aria-describedby', [...ids, ID].join(' '));
    // Below the element, kept inside the window; above it when there is no room below.
    const r = el.getBoundingClientRect();
    const w = Math.min(280, innerWidth - 16);
    box.style.maxWidth = `${w}px`;
    const bw = box.offsetWidth, bh = box.offsetHeight;
    const left = Math.max(8, Math.min(innerWidth - bw - 8, r.left + r.width / 2 - bw / 2));
    const top = r.bottom + 6 + bh > innerHeight ? Math.max(8, r.top - bh - 6) : r.bottom + 6;
    box.style.left = `${left + scrollX}px`;
    box.style.top = `${top + scrollY}px`;
  };
  const tipped = (e) => e.target.closest?.('[data-tip]');

  root.addEventListener('pointerover', (e) => {
    const el = tipped(e);
    if (!el || el === owner || e.pointerType === 'touch') return;
    clearTimeout(timer);
    timer = setTimeout(() => show(el), DELAY_MS);
  }, { signal });
  root.addEventListener('pointerout', (e) => {
    const el = tipped(e);
    if (el && !el.contains(e.relatedTarget) && !el.matches(':focus')) hide();
    else if (el) clearTimeout(timer);
  }, { signal });
  root.addEventListener('focusin', (e) => { const el = tipped(e); if (el && el.matches(':focus-visible')) show(el); }, { signal });
  root.addEventListener('focusout', (e) => { if (tipped(e) === owner) hide(); }, { signal });
  root.addEventListener('click', (e) => {
    const info = e.target.closest?.('button.info[data-tip]');
    if (info) { e.preventDefault(); if (owner === info && !box.hidden) hide(); else show(info); return; }
    const hint = e.target.closest?.('[data-hint-close]');
    if (hint) dismissHint(hint.closest('[data-hint-once]'));
    else if (owner?.matches('button.info')) hide();
  }, { signal });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) { hide(); } }, { signal });
  addEventListener('scroll', hide, { signal, passive: true, capture: true });
  root.dataset.hintsOff = readHints().join(' ');
}

/**
 * An ⓘ button for `text`, for touch screens and anyone who wants the tooltip without hovering. Its name says what it
 * explains ("About Act"), so a screen-reader user tabbing through can tell the buttons apart.
 */
export const infoButton = (text, esc, term) => (text ? `<button type="button" class="info" data-tip="${esc(text)}" aria-label="${esc(t('tip.button', { term }))}">ⓘ</button>` : '');

/** A screen's one-line first-time hint (`hint.<screen>`), with its dismiss button. Hidden by CSS once dismissed. */
export const hintHtml = (screen, esc) => `<p class="first-hint hint" data-hint-once="${esc(screen)}" role="note"><span>${esc(t(`hint.${screen}`))}</span> <button type="button" class="link" data-hint-close>${esc(t('hint.dismiss'))}</button></p>`;

// Dismissed hints are a token list on the root (`data-hints-off`), so a hint drawn later is hidden too.
const HINTS = 'orgcraft.hints.dismissed';
function readHints() { try { return JSON.parse(localStorage.getItem(HINTS) ?? '[]'); } catch { return []; } }
function dismissHint(el) {
  if (!el) return;
  const root = el.closest('.ats') ?? document.documentElement;
  const off = new Set((root.dataset.hintsOff ?? '').split(' ').filter(Boolean)).add(el.dataset.hintOnce);
  root.dataset.hintsOff = [...off].join(' ');
  try { localStorage.setItem(HINTS, JSON.stringify([...off])); } catch { /* private mode: this session only */ }
}
