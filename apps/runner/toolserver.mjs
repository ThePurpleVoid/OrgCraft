// The team tool server's way out: every call that passes the local check (tools.mjs) goes to the control plane at
// POST /v1/sessions/{session}/tools/{tool} with the session's token. The server checks it again, mints the event
// with the actor taken from the token, and wakes whoever it wakes. The token lives here, in the runner process,
// never in the agent's environment or prompt (docs/product/m3-design.md section 3).
export function toolServer({ server, session, token, renew, fetch: f = globalThis.fetch }) {
  let current = token;
  const base = `${server.replace(/\/+$/, '')}/v1/sessions/${encodeURIComponent(session)}/tools/`;
  async function post(tool, input, key) {
    return f(base + encodeURIComponent(tool), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${current}`, 'idempotency-key': key },
      body: JSON.stringify(input),
    });
  }
  return {
    setToken(t) { current = t; },
    /** Returns { result } on success, { problems } when refused, or throws when the control plane cannot be reached. */
    async call(tool, input) {
      if (!current) return { problems: ['this session has no tool token yet; try again in a moment'] };
      // One key per call, kept across the retry, so a call the server already took is not taken twice.
      const key = `${session}.${tool}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
      let res = await post(tool, input, key);
      if (res.status === 401 && renew) { current = (await renew()) ?? current; res = await post(tool, input, key); }
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { result: body };
      if (res.status === 422) return { problems: Array.isArray(body.problems) && body.problems.length ? body.problems : [body.error ?? 'the call was refused'] };
      return { problems: [`the control plane answered ${res.status}: ${body.error ?? body.title ?? 'no reason given'}`] };
    },
  };
}
