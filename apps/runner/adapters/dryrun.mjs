// The dry run's fake model (M3 exit test, Pass A): a scripted chief of staff, builder and QA that play the demo
// request end to end through the real runner paths (the tools, the policy, checkpoints, proposals, approvals), with
// no model and no key. A control folder lets a test or a person steer it from outside (tools/dry-run/m3.mjs):
//
//   builder.json      { "role": "web-dev", "file": "app/request.md" } the builder and the file it changes
//   qa-signoff.json   { "evidence": [...], "walked": "...", "testedOn": "...", "result": "pass" } QA's SIGNOFF; the
//                     QA role waits for it after its HANDOFF (step 6), then the file is used up
//   spend.json        { "usd": 6 } the next turn reports that cost, then the file is used up (step 11)
//   meeting-spend.json { "usd": 1 } the next attendee's meeting turn costs that and does not answer (the cap path)
//
// The front door also asks the owner one decision (step 7) and says what they chose when the answer comes. In a
// meeting every role answers its turn and the facilitator closes it with minutes made of the replies.
// Every step is written to the control folder's log.jsonl with the run and session ids.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stubAdapter } from './stub.mjs';

const TURN_USD = 0.01;
const QA_WAIT_MS = 60 * 60_000;

export function dryrunAdapter({ control, qaRole = 'qa-web', frontDoor = 'chief-of-staff' }) {
  if (!control) throw new Error('the dry-run model needs a control folder (AGENT_TEAM_DRYRUN_CONTROL)');
  const read = (name) => { try { return JSON.parse(readFileSync(join(control, name), 'utf8')); } catch { return null; } };
  const take = (name) => { const v = read(name); if (v) rmSync(join(control, name), { force: true }); return v; };
  const builder = () => read('builder.json') ?? { role: 'web-dev', file: 'app/request.md' };
  // The step log is read by the harness, which may run as another user (the runner's umask is 077).
  const log = (t, step, more = {}) => { appendFileSync(join(control, 'log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), run: t.env.AGENT_TEAM_RUN, session: t.env.AGENT_TEAM_SESSION, role: t.role, step, ...more })}\n`); chmodSync(join(control, 'log.jsonl'), 0o644); };
  const usage = () => ({ inputTokens: 1000, outputTokens: 200, costUsd: take('spend.json')?.usd ?? TURN_USD });
  const kind = (prompt) => (/\b([A-Z]{4,}) from ([a-z0-9][\w#-]*)/.exec(prompt) ?? []).slice(1);
  const request = (prompt) => {
    const quoted = prompt.split('\n').filter((l) => l.startsWith('> ')).map((l) => l.slice(2));
    return quoted.length ? quoted.join('\n') : null;
  };

  const script = {
    // The front door: answers the owner and hands the request to the builder; tells the owner when it lands.
    [frontDoor]: async (t) => {
      const asked = request(t.prompt);
      // G-15: "Web dev and QA web on the checkout errors, now" starts an ad hoc meeting with those roles.
      const now = asked && /^(.+?)\s+on\s+(.+?),?\s+now\.?$/i.exec(asked.trim());
      if (now) {
        const who = now[1].toLowerCase();
        const attendees = [builder().role, qaRole].filter((r) => who.includes(r) || who.includes(r.replace(/-/g, ' ')));
        const topic = now[2].trim();
        const r = await t.call('meeting_start', { title: topic.charAt(0).toUpperCase() + topic.slice(1), agenda: `What you know about ${topic}, and what you would do next.`, attendees });
        t.say(r.isError ? `I could not start that meeting: ${r.text}` : `Starting a meeting now with ${attendees.join(' and ')} on ${topic}. The minutes will be here.`);
        let meeting;
        try { meeting = JSON.parse(r.text).meeting; } catch { /* refused: the text says why */ }
        log(t, 'chief-of-staff:meeting-started', { attendees, meeting, ok: !r.isError, detail: r.isError ? r.text.slice(0, 300) : undefined });
        return { usage: usage() };
      }
      if (asked !== null) {
        const b = builder();
        const task = asked.split('\n')[0].slice(0, 200) || 'the owner\'s request';
        t.say(`On it. I'm handing this to ${b.role}: ${task}`);
        // Step 7: one decision for the owner (a card they answer, from the phone too); the work goes on meanwhile.
        const d = await t.call('ask_owner', { question: `Where should "${task.slice(0, 120)}" go?`, options: [
          { id: 'home', label: 'On the home page', consequence: 'The change goes on the page everyone sees first.' },
          { id: 'new-page', label: 'On a page of its own', consequence: 'The change gets its own page, linked from the menu.' },
        ], recommended: 'home', why: 'Most visitors only see the home page.' });
        log(t, 'chief-of-staff:asked', { ok: !d.isError, detail: d.isError ? d.text : undefined });
        const r = await t.call('handoff', { to: b.role, task, changed: 'nothing yet: a request from the owner, quoted below', verify: `the change in ${b.file} says what was asked`, doneWhen: 'merged after the owner approves it' });
        log(t, 'chief-of-staff:handoff', { to: b.role, ok: !r.isError, detail: r.isError ? r.text : undefined });
        return { usage: usage() };
      }
      const answered = /The owner answered your question.*?: "([^"]*)"/.exec(t.prompt);
      if (answered) {
        t.say(`Noted: ${answered[1] === 'new-page' ? 'on a page of its own' : 'on the home page'}. I've passed it on.`);
        log(t, 'chief-of-staff:answered', { answer: answered[1] });
        return { usage: usage() };
      }
      const [k, from] = kind(t.prompt);
      if (k === 'HANDOFF' && from) {
        t.say(`${from} says it is done: ${/changed: (.*)/.exec(t.prompt)?.[1] ?? 'see the board'}.`);
        log(t, 'chief-of-staff:reported', { from });
      }
      return { usage: usage() };
    },
    // QA: waits for the SIGNOFF a person (or the CI test) writes, then sends it with that evidence.
    [qaRole]: async (t) => {
      const [k, from] = kind(t.prompt);
      if (k !== 'HANDOFF') return { usage: usage() };
      log(t, 'qa:waiting-for-signoff', { from });
      const until = Date.now() + QA_WAIT_MS;
      let s = null;
      while (!s && Date.now() < until && !t.signal.aborted) {
        s = take('qa-signoff.json');
        if (!s) await new Promise((r) => setTimeout(r, 250));
      }
      if (!s) { log(t, 'qa:no-signoff'); return { usage: usage() }; }
      const task = /task: (.*)/.exec(t.prompt)?.[1] ?? 'the change';
      const r = await t.call('signoff', { to: from, task, testedOn: s.testedOn ?? 'the dry run (stand-in remote)', walked: s.walked ?? 'the M3 exit test script', result: s.result ?? 'pass', evidence: s.evidence ?? [] });
      log(t, 'qa:signoff', { to: from, ok: !r.isError, detail: r.isError ? r.text : undefined });
      return { usage: usage() };
    },
    // The builder: on the HANDOFF, changes its file and hands it to QA (the runner pushes and opens the PR first);
    // on QA's SIGNOFF, asks the owner to accept (the runner merges after approval, pinned to the head).
    '*': async (t) => {
      const b = builder();
      if (t.role !== b.role) return { usage: usage() };
      const [k, from] = kind(t.prompt);
      const task = /task: (.*)/.exec(t.prompt)?.[1] ?? 'the owner\'s request';
      if (k === 'HANDOFF') {
        const content = `# ${task}\n\nDone in the dry run by ${t.role}.\n`;
        const w = await t.use('Write', { file_path: join(t.cwd, b.file), content }, () => { mkdirSync(dirname(join(t.cwd, b.file)), { recursive: true }); writeFileSync(join(t.cwd, b.file), content); });
        log(t, 'builder:changed', { file: b.file, ok: Boolean(w.ok), detail: w.refused });
        const r = await t.call('handoff', { to: qaRole, task, changed: `${b.file}`, verify: `read ${b.file} on the pull request`, doneWhen: 'you send a SIGNOFF with evidence' });
        log(t, 'builder:handoff', { to: qaRole, ok: !r.isError, detail: r.isError ? r.text : undefined });
      } else if (k === 'SIGNOFF') {
        const r = await t.call('request_approval', { action: 'accept', call: `merge the pull request for: ${task}`, why: `${from} signed off` });
        log(t, 'builder:accept', { ok: !r.isError, detail: r.text.slice(0, 500) });
        if (!r.isError) await t.call('handoff', { to: frontDoor, task, changed: `merged: ${task}`, verify: 'the base branch has the change', doneWhen: 'you tell the owner' });
      }
      return { usage: usage() };
    },
  };
  // Meetings (written round): an attendee answers its turn; the facilitator writes the minutes from the replies.
  const meeting = async (t) => {
    const id = /\(meeting (mtg_[\w-]+)\)/.exec(t.prompt)?.[1];
    if (!id) return null;
    // meeting-spend.json { "usd": 1 }: this attendee's turn costs that much and ends before it answers (the cap path).
    const blew = !/close this meeting/.test(t.prompt) && take('meeting-spend.json');
    if (blew) { log(t, 'meeting:spent', { meeting: id, usd: blew.usd }); return { usage: { inputTokens: 1000, outputTokens: 200, costUsd: Number(blew.usd) } }; }
    if (/close this meeting/.test(t.prompt)) {
      const said = [...t.prompt.matchAll(/^- ([a-z0-9][\w#-]*), verbatim:\n {2}> (.*)$/gm)].map((x) => `${x[1]}: ${x[2]}`);
      const capped = /cost cap/.test(t.prompt);
      const minutes = `${said.length ? said.join('\n') : 'Nobody spoke.'}${capped ? '\n\nThe meeting reached its cost cap; these minutes are partial.' : ''}`;
      const r = await t.call('meeting_close', { meeting: id, minutes });
      log(t, 'meeting:closed', { meeting: id, capped, replies: said.length, ok: !r.isError, detail: r.isError ? r.text : undefined });
    } else {
      const r = await t.call('meeting_reply', { meeting: id, text: `${t.role}: on track, nothing blocks me.` });
      log(t, 'meeting:replied', { meeting: id, ok: !r.isError, detail: r.isError ? r.text : undefined });
    }
    return { usage: usage() };
  };
  for (const [k, f] of Object.entries(script)) script[k] = async (t) => (await meeting(t)) ?? f(t);
  if (!existsSync(control)) throw new Error(`the control folder ${control} does not exist`);
  return { ...stubAdapter(script), runtime: 'dryrun' };
}
