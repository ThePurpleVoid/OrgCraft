// The live board for the Studio's canvas: where every role stands, from the team's own reports. Two sources:
//   - the control plane (apps/server), when AGENT_TEAM_SERVER, AGENT_TEAM_SERVER_TOKEN and AGENT_TEAM_SERVER_TEAM
//     are set. This server calls it, so the token never reaches the page.
//   - otherwise the local event log, ~/.agent-team/<project>/events.jsonl, which team-status.sh and the hooks
//     append to on this machine.
// changes() tells the page when to fetch the board again; the page never needs to know which source it is.
import { existsSync, unwatchFile, watchFile } from 'node:fs';
import { readLog, summarize } from '../../tools/board.mjs';
import { context } from '../../tools/report.mjs';

export function liveSource(root, env = process.env) {
  const server = env.AGENT_TEAM_SERVER?.replace(/\/+$/, '');
  if (server && env.AGENT_TEAM_SERVER_TOKEN && env.AGENT_TEAM_SERVER_TEAM) {
    const team = encodeURIComponent(env.AGENT_TEAM_SERVER_TEAM);
    const headers = { authorization: `Bearer ${env.AGENT_TEAM_SERVER_TOKEN}` };
    return {
      kind: 'server',
      where: `${server}/v1/teams/${team}`,
      async board() {
        const res = await fetch(`${server}/v1/teams/${team}/board`, { headers, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`the control plane answered HTTP ${res.status}`);
        return res.json();
      },
      /** Calls fn on every new event until the returned stop() is called. Reconnects after a drop. */
      changes(fn) {
        let ctl = null, stopped = false, last = '';
        const loop = async () => {
          while (!stopped) {
            ctl = new AbortController();
            try {
              const res = await fetch(`${server}/v1/teams/${team}/events/stream`, { headers: { ...headers, ...(last ? { 'last-event-id': last } : {}) }, signal: ctl.signal });
              const dec = new TextDecoder();
              let buf = '';
              for await (const chunk of res.body) {
                buf += dec.decode(chunk, { stream: true });
                let i;
                while ((i = buf.indexOf('\n\n')) >= 0) {
                  const id = /^id: (.+)$/m.exec(buf.slice(0, i))?.[1];
                  buf = buf.slice(i + 2);
                  if (id) { last = id; fn(); }
                }
              }
            } catch { /* dropped or stopped */ }
            if (!stopped) await new Promise((r) => setTimeout(r, 3000));
          }
        };
        loop();
        return () => { stopped = true; ctl?.abort(); };
      },
    };
  }
  const { log } = context(env, root);
  return {
    kind: 'log',
    where: log,
    async board() { return { ...summarize(readLog(log)), asOf: null }; },
    changes(fn) {
      const watch = () => fn();
      watchFile(log, { interval: 1000 }, watch);
      return () => unwatchFile(log, watch);
    },
    exists: () => existsSync(log),
  };
}
