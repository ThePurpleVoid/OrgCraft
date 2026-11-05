# The dashboard

The dashboard draws your team from its role briefs and lights each role up from what its thread reports. It has the org chart (who reports to whom, with each lead summarising its team), the flow (who hands work to whom; edges that carried a message this week are coloured, and ones from the last 15 minutes move), a panel per role (task, status, whom it waits on, links to the issue, PR, branch and commit, the brief, the history), the feed of every report, and a phone layout.

It is one page, `scripts/agent-team/dashboard/`, with no dependencies and no build step. It runs in three ways.

## 1. On your machine

```sh
node scripts/agent-team/dashboard.mjs          # http://localhost:4747
node scripts/agent-team/dashboard.mjs --open --port 8080
```

Threads on the same machine need nothing else. `team-status.sh` appends every report to `~/.agent-team/<project>/events.jsonl`; the dashboard watches that file and the page updates within a second. The roster is read from `docs/team/` on every request, so a sync shows up on the next refresh.

Want to see it work before your team reports anything? `--demo` plays made-up reports through a scratch log:

```sh
npx --yes github:PurpleGiragge/Agent-Team-Kit dashboard --demo
```

## 2. Threads on other machines or in the cloud

Start the dashboard where other machines can reach it, with a token:

```sh
DASHBOARD_TOKEN="$(openssl rand -hex 16)" node scripts/agent-team/dashboard.mjs --host 0.0.0.0
```

On each other machine (or in the cloud environment's variables) set:

```sh
TEAM_REPORT_URL=http://<dashboard machine>:4747/api/report
TEAM_REPORT_TOKEN=<the same token>
```

`team-status.sh` then posts every report there as well as writing its own log. Each report carries an id, so a report that arrives twice is kept once.

## 3. On your website, readable from anywhere

For a dashboard you can open from your phone, keep the reports in a [hosted board](../board/supabase/README.md) (a Supabase table and Edge Function) and serve the same page from your site.

1. Deploy the hosted board and point every machine's `TEAM_REPORT_URL` and `TEAM_REPORT_TOKEN` at it.
2. In your site's build, export the page with the current roster:

   ```sh
   node scripts/agent-team/dashboard.mjs export --out public/team --board https://<project-ref>.supabase.co/functions/v1/team-report
   ```

   This writes `index.html`, `app.js`, `app.css`, `roster.json` and `config.js`. Running it at build time keeps the chart in step with the briefs. Do not commit the output; it is generated.
   **Inside your own web app** (React, Vue, anything with a bundler), let sync write the page code and roster straight into your source instead, so they stay in step with the briefs without a build step:

   ```json
   "dashboard": { "export": "web/src/admin/team-board", "repo": "https://github.com/you/your-repo" }
   ```

   Add `"staleMinutes": { "working": 15, "waiting": 120, "review": 120, "blocked": 120 }` to set how long a thread in each status may stay silent before its card says it has gone quiet (default 30 each). The local dashboard reads the same setting from `team.json`; `team-board.sh` reads `STALE_MINUTES` and `STALE_WAITING_MINUTES` from `.agent-team/config.sh`.

   in `.agent-team/team.json`, then `scripts/agent-team/sync.sh`. It writes `app.js`, `app.css` and `roster.json` there (generated, committed, checked by `sync.sh check`). Import them and mount (React shown):

   ```tsx
   import roster from './team-board/roster.json';
   import './team-board/app.css';
   import './team-board/app.js'; // defines window.AgentTeamDashboard

   export function TeamBoard({ role }: { role?: string }) {
     const el = useRef<HTMLDivElement>(null);
     const board = useRef<{ select(id: string): void; destroy(): void }>();
     useEffect(() => {
       board.current = window.AgentTeamDashboard.mount(el.current!, {
         roster, embedded: true, urlState: false, stream: null, role,
         fetchBoard: ({ role, days }) => api.teamBoard({ role, days }),   // your authenticated API
         onSelect: (id) => navigate(id ? `/admin/team/${encodeURIComponent(id)}` : '/admin/team'),
       });
       return () => board.current?.destroy();
     }, []);
     useEffect(() => board.current?.select(role ?? ''), [role]);
     return <div ref={el} />;
   }
   ```

3. Give the page a way to read the board. The read token must not be public, so choose one:
   - **Behind your own sign-in (recommended).** Mount the dashboard inside your app and fetch the board through your own authenticated API, which holds the read token on the server:

     ```html
     <link rel="stylesheet" href="/team/app.css">
     <div id="team"></div>
     <script src="/team/app.js"></script>
     <script>
       AgentTeamDashboard.mount(document.getElementById('team'), {
         roster: '/team/roster.json',
         fetchBoard: ({ role, days }) => myApi.get('/admin/team-board', { role, days }),  // your API calls the hosted board
         stream: null,
       });
     </script>
     ```

     In React, call `mount` in an effect on a `ref` and `destroy()` on cleanup.
   - **A private page.** If the page itself is private (behind your host's access control), put the read token in `config.js`: `headers: { 'x-team-read-token': '…' }`, and set `TEAM_DASHBOARD_ORIGINS=https://your.site` on the Edge Function so the browser may call it.

The page polls every 15 seconds when it reads a hosted board.

## Options

`AgentTeamDashboard.mount(element, options)` and `window.AGENT_TEAM` in `config.js` take the same options:

| Option | Default | What it does |
| --- | --- | --- |
| `roster` | `/api/roster` | The roster object, a URL to `roster.json`, or an async function returning it |
| `board` | `/api/board` | A URL that answers like the hosted board's GET |
| `fetchBoard` | | `async ({ role, days }) => board`, instead of `board`, to use your own API |
| `headers` | | Extra headers for `board`, or an async function returning them |
| `stream` | `/api/stream` | A server-sent events URL that says when to reload; `null` to poll |
| `poll` | `15000` | Milliseconds between reloads without a stream |
| `repo` | from git | `https://github.com/owner/repo` for issue, PR, branch, commit and brief links |
| `urlState` | `true` | Keep the open role and the view in the query string, so links to a role work |
| `role`, `view` | | The role open at the start (`cto`, `code-reviewer#57`) and the view (`org` or `flow`) |
| `onSelect` | | `(id) => …` when a role is opened (`''` when closed), to drive your own router |
| `embedded` | `false` | Inside another app's page: no page padding, background or title |

`mount` returns `{ reload, select, destroy }`; `select(id)` opens a role without calling `onSelect`. Every style is scoped to `.atd`, and the colours are CSS variables (`--accent`, `--good`, `--warn`, `--bad`, `--bg`, `--card`, `--ink`, …) you can override to match your site.

## Command reference

```
node scripts/agent-team/dashboard.mjs [--port 4747] [--host 127.0.0.1] [--dir <repo>] [--demo] [--open]
node scripts/agent-team/dashboard.mjs export --out <dir> [--board <url>] [--dir <repo>]
```

| Variable | Where | What it does |
| --- | --- | --- |
| `DASHBOARD_TOKEN` | dashboard | Require this token (`x-team-token`) on `POST /api/report` |
| `DASHBOARD_PORT`, `DASHBOARD_HOST` | dashboard | Defaults for `--port` and `--host` |
| `TEAM_BOARD_URL`, `TEAM_READ_TOKEN` | dashboard | Read a hosted board instead of the local log |
| `TEAM_REPORT_URL`, `TEAM_REPORT_TOKEN` | threads | Also post every report there |
| `TEAM_DASHBOARD_ORIGINS` | Edge Function | Origins allowed to read the hosted board from a browser |

The server's API: `GET /api/roster` (the team from the briefs), `GET /api/board?role=&days=` (same shape as the hosted board), `GET /api/stream` (server-sent events), `POST /api/report` (one report, as `team-status.sh` sends it).
