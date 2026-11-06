// The Studio for a host's own page (docs/specs/studio-embed.md section 4, docs/studio-in-your-app.md):
//
//   <link rel="stylesheet" href="/api/agent-team/studio/assets/<kit version>/app.css">
//   <script type="module" src="/your/own/admin-team.js"></script>
//
//   // admin-team.js, served by your site (a strict CSP allows it: script-src 'self')
//   import { mount } from '/api/agent-team/studio/assets/<kit version>/studio.js';
//   const studio = mount(document.getElementById('team'), {
//     api: '/api/agent-team/studio',
//     headers: async () => ({ authorization: `Bearer ${await session.token()}` }),
//     features: { publish: true, chat: false, runs: false, live: false },
//     embedded: true,
//     onNavigate: (page) => {},
//   });
//   // later: studio.destroy();
//
// It also sets globalThis.AgentTeamStudio = { mount } for a page that loads it with a plain module script tag.
import { mount as mountStudio } from './app.js';

/** mount() with the embedded defaults: no URL state, no launch token, step 1 features unless the host says. */
export function mount(el, opts = {}) {
  return mountStudio(el, { embedded: true, ...opts });
}

globalThis.AgentTeamStudio = Object.freeze({ mount });
