// The Studio's page: the bar, the editor's three panes, the other pages and the dialogs. mount() renders it into its
// root, so the same markup serves the local Studio (index.html mounts into body) and a host's admin page.
// No inline styles or scripts (embed spec 4, strict CSP).
export const SHELL = `
<header class="bar">
  <div class="brand"><strong>OrgCraft Studio</strong> <span id="project" class="muted"></span></div>
  <nav id="pages" class="views pages" aria-label="Pages">
    <button type="button" data-page="team" aria-pressed="true">Team</button>
    <button type="button" data-page="meetings" aria-pressed="false">Meetings</button>
    <button type="button" data-page="rollout" aria-pressed="false">Rollout</button>
    <button type="button" data-page="chat" aria-pressed="false">Chat</button>
  </nav>
  <div class="bar-actions team-only">
    <span id="checks" class="pill" role="status"></span>
    <button id="impact-pill" type="button" class="pill warn" hidden></button>
    <button id="undo" type="button" title="Undo (Ctrl+Z)">Undo</button>
    <button id="redo" type="button" title="Redo (Ctrl+Shift+Z)">Redo</button>
    <button id="publish" type="button" class="primary">Publish…</button>
  </div>
</header>
<section id="template-bar" class="template-bar team-only" aria-label="Starting team" hidden></section>
<p class="readonly-note hint team-only">On a small screen the team is read-only. Edit it on a larger screen.</p>
<main class="layout team-only">
  <aside class="palette" aria-label="Role library">
    <div class="palette-head"><input id="search" type="search" placeholder="Search roles" aria-label="Search roles"><button id="new-agent" type="button" class="primary edit-only">New agent</button></div>
    <p class="hint"><span class="edit-only">Switch roles on and off, or drag one onto a manager on the canvas.</span><span class="small-only">The roles in this team. Change them on a larger screen.</span></p>
    <div id="library"></div>
  </aside>
  <section class="canvas-wrap" aria-label="Org chart">
    <div class="canvas-head">
      <nav id="views" class="views" aria-label="Views">
        <button type="button" data-view="org" aria-pressed="true">Org</button>
        <button type="button" data-view="flow" aria-pressed="false">Flow</button>
        <button type="button" data-view="systems" aria-pressed="false">Systems</button>
        <button type="button" data-view="areas" aria-pressed="false">Owned areas</button>
        <button type="button" data-view="checks" aria-pressed="false">Checks</button>
      </nav>
      <span id="summary" class="muted"></span>
      <button id="live" class="canvas-only live-toggle" type="button" aria-pressed="false" title="Show where every role stands, from the team's reports">Live</button>
      <span class="row zoom canvas-only"><button id="zoom-out" type="button" aria-label="Zoom out">−</button><button id="zoom-fit" type="button" title="Fit or actual size"><span id="zoom-level">100%</span></button><button id="zoom-in" type="button" aria-label="Zoom in">+</button></span>
    </div>
    <p id="draft-banner" class="draft-banner" hidden></p>
    <p class="mode-hint hint" data-for="org"><span class="edit-only">Drag a card onto another to change who it reports to. Click a card to edit it.</span><span class="small-only">Who reports to whom. Tap a card to see the role.</span></p>
    <p class="mode-hint hint" data-for="flow">Who hands work to whom, from each role's "Hands to". Click a role to see its hand-offs: blue goes out, green comes in.</p>
    <div id="systems-strip" class="systems-strip" data-for="systems"></div>
    <div id="canvas" class="canvas"></div>
  </section>
  <aside class="inspector" aria-label="Role inspector">
    <div id="inspector"><p class="muted">Pick a role on the canvas or in the library.</p></div>
    <h2>Problems</h2>
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
