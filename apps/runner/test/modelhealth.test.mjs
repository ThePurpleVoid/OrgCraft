// L29 outage mode, the runner's side: the model proxy notices when the model provider stops answering, says so once,
// probes until it is back, and says that once too. The runner forwards each change to the control plane.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startModelProxy } from '../modelproxy.mjs';

test('the model proxy reports unreachable after two failures, probes /v1/models while down, and reports ok when it answers', async () => {
  let mode = 'down';
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (mode === 'down') throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (mode === 'overloaded') return new Response('{}', { status: 529 });
    return new Response('{}', { status: 200 });
  };
  const changes = [];
  const proxy = startModelProxy({ upstream: 'https://model.example', key: () => 'sk-ant-test-0123456789abcdefghij', fetch: fakeFetch, onHealth: (h) => changes.push(h), probeMs: 20 });
  await proxy.ready;
  try {
    const { baseUrl, token } = proxy.register('s');
    const ask = () => fetch(`${baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': token, 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await ask()).status, 502);
    assert.equal(proxy.health().state, 'unknown', 'one failure is a blip');
    mode = 'overloaded';
    assert.equal((await ask()).status, 529);
    assert.deepEqual([proxy.health().state, proxy.health().error, proxy.health().provider], ['unreachable', 'HTTP 529', 'Anthropic']);
    assert.equal(changes.length, 1);
    mode = 'up';
    for (let i = 0; i < 100 && proxy.health().state !== 'ok'; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(proxy.health().state, 'ok', 'the probe noticed it is back with no session asking');
    assert.ok(calls.some((u) => u === 'https://model.example/v1/models?limit=1'));
    assert.deepEqual(changes.map((c) => c.state), ['unreachable', 'ok']);
    const n = calls.length;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls.length, n, 'no probing while it answers');
  } finally { await proxy.close(); }
});
