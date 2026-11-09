// The Studio's page: the bar, the editor's three panes, the other pages and the dialogs. mount() renders it into its
// root, so the same markup serves the local Studio (index.html mounts into body) and a host's admin page.
// No inline styles or scripts (embed spec 4, strict CSP).
import { t, tip } from './i18n.js';
import { hintHtml } from './tooltip.js';

const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const SHELL = `
<a class="skip" href="#content">${t('nav.skip')}</a>
<header class="bar">
  <div class="brand"><strong>OrgCraft</strong> <span id="project" class="muted"></span></div>
  <h1 id="page-title" class="sr-only">${t('nav.team')}</h1>
  <!-- SH-1: the tabs whose screens exist in this build; the rest of the seven arrive with their slices (SH-9). -->
  <nav id="pages" class="views pages" aria-label="Pages">
    <button type="button" data-page="team" aria-pressed="true" aria-current="page" data-tip="${attr(tip('team'))}">${t('nav.team')}</button>
    <button type="button" data-page="chat" aria-pressed="false">${t('nav.chat')}</button>
    <span class="more-wrap"><button type="button" id="more-btn" class="more-btn" aria-haspopup="true" aria-expanded="false" aria-controls="more-menu">${t('nav.more')}</button>
      <span id="more-menu" class="more-menu" hidden><button type="button" data-page="meetings" aria-pressed="false">${t('nav.meetings')}</button><button type="button" data-page="rollout" aria-pressed="false">${t('rollout.title')}</button></span></span>
  </nav>
  <div class="bar-actions team-only">
    <span id="checks" class="pill" role="status"></span>
    <button id="impact-pill" type="button" class="pill warn" hidden></button>
    <button id="undo" type="button" title="Undo (Ctrl+Z)">Undo</button>
    <button id="redo" type="button" title="Redo (Ctrl+Shift+Z)">Redo</button>
    <button id="publish" type="button" class="primary" data-tip="${attr(tip('publish'))}">${t('canvas.publish.none')}</button>
  </div>
</header>
<section id="template-bar" class="template-bar team-only" aria-label="Starting team" hidden></section>
<main id="content" class="layout team-only" tabindex="-1">
  <aside class="palette" aria-label="Role library">
    <div class="palette-head"><input id="search" type="search" placeholder="Search roles" aria-label="Search roles"><button id="new-agent" type="button" class="primary edit-only">${t('catalog.custom')}</button></div>
    <p id="cat-how" class="hint edit-only">${t('catalog.how')}</p>
    <div id="library" data-catalog></div>
  </aside>
  <section class="canvas-wrap" aria-label="${t('canvas.view.chart')}">
    <div class="canvas-head">
      <nav id="views" class="views" aria-label="Views">
        <button type="button" data-view="org" aria-pressed="true">${t('canvas.view.chart')}</button>
        <button type="button" data-view="flow" aria-pressed="false">${t('canvas.view.handoffs')}</button>
        <button type="button" data-view="systems" aria-pressed="false">${t('canvas.view.systems')}</button>
        <button type="button" data-view="areas" aria-pressed="false">${t('canvas.view.areas')}</button>
        <button type="button" data-view="checks" aria-pressed="false">${t('canvas.view.checks')}</button>
      </nav>
      <span id="summary" class="muted" data-tip="${attr(tip('dashed.card.or.wire'))}"></span>
      <button id="live" class="canvas-only live-toggle" type="button" aria-pressed="false" title="Show where every role stands, from the team's reports">Live</button>
      <span class="row zoom canvas-only"><button id="zoom-out" type="button" aria-label="Zoom out">−</button><button id="zoom-level" type="button" title="Actual size">100%</button><button id="zoom-in" type="button" aria-label="Zoom in">+</button><button id="zoom-fit" type="button">${t('canvas.fit')}</button></span>
    </div>
    <p id="draft-banner" class="draft-banner" hidden></p>
    <p id="restored" class="restored" role="status" hidden><span></span> <button type="button" class="link" id="restored-discard">${t('canvas.discard')}</button></p>
    ${hintHtml('team', attr)}
    <p class="mode-hint hint" data-for="org"><span class="edit-only">Drag a card onto another to change who it reports to. Click a card to edit it.</span><span class="small-only">Who reports to whom. Tap a card to see the role.</span></p>
    <p class="mode-hint hint" data-for="flow">Who hands work to whom, from each role's "Hands to". Click a role to see its hand-offs: blue goes out, green comes in.</p>
    <div id="systems-strip" class="systems-strip" data-for="systems"></div>
    <div id="canvas" class="canvas"></div>
  </section>
  <aside class="inspector" aria-label="Role inspector">
    <div id="inspector"><p class="muted">Pick a role on the canvas or in the library.</p></div>
    <h2>${t('check.heading')}</h2>
    <ul id="issues" class="issues"></ul>
  </aside>
</main>
<section id="agent-editor" class="agent-editor team-only" aria-label="Agent editor" hidden></section>
<section id="gallery-page" class="gallery-page gallery-only" aria-label="Start a team"></section>
<section id="meetings-page" class="meetings-page meetings-only" aria-label="Meetings"></section>
<section id="chat-page" class="chat-page chat-only" aria-label="Chat with the chief of staff"></section>
<section id="rollout-page" class="rollout-page rollout-only" aria-label="Rollout of the published team" aria-live="polite"></section>
<dialog id="publish-dialog">
  <form method="dialog" class="dialog">
    <h2>Publish the team</h2>
    <p class="muted local-only">Writes <code>.agent-team/</code>, runs sync, and commits the result on a branch. Review the changes, then open a pull request as usual.</p>
    <p class="muted embedded-only">Writes the team's files on a new branch and opens a pull request. Nothing changes until someone merges it.</p>
    <div id="impact"></div>
    <div id="plan" class="plan-preview" hidden></div>
    <div id="changes" class="changes"></div>
    <label>Branch <input id="branch" required pattern="[A-Za-z0-9._\\/\\-]+"></label>
    <label>Commit message <input id="message"></label>
    <p id="publish-result" class="result" role="status"></p>
    <div class="dialog-actions">
      <button value="cancel" type="submit">Close</button>
      <button id="confirm" type="button" class="primary"><span class="local-only">Commit to branch</span><span class="embedded-only">Open a pull request</span></button>
    </div>
  </form>
</dialog>
<dialog id="create-dialog" aria-labelledby="create-title">
  <form id="create-form" class="dialog">
    <h2 id="create-title">Use this template</h2>
    <p id="create-what" class="muted"></p>
    <label>Project name <input id="c-project" required maxlength="80" autocomplete="off"></label>
    <label>Owner's name <input id="c-owner" maxlength="80" placeholder="the owner" autocomplete="name"><span class="hint">Who the team reports to. The chief of staff writes to this person.</span></label>
    <label>Time zone <input id="c-zone" maxlength="64" autocomplete="off"><span class="hint">For schedules and meetings. This browser's, unless you change it.</span></label>
    <p id="create-result" class="result error" role="status"></p>
    <div class="dialog-actions">
      <button type="button" id="create-cancel">Cancel</button>
      <button type="submit" class="primary">Open the team</button>
    </div>
  </form>
</dialog>
<dialog id="agent-dialog" aria-labelledby="agent-title"></dialog>
`;
