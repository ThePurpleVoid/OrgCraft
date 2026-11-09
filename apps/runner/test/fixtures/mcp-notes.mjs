// A tiny local MCP server for the sidecar tests (stdio). It reports what it can see: its own environment, the
// idempotency key it was given, and a result large enough to be cut.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const obj = (props = {}) => ({ type: 'object', properties: props });
const server = new Server({ name: 'notes', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
  { name: 'read_env', description: 'echo one environment variable', inputSchema: obj({ name: { type: 'string' } }) },
  { name: 'key', description: 'the idempotency key of this call', inputSchema: obj({ n: { type: 'number' } }) },
  { name: 'send_note', description: 'send a note outside', inputSchema: obj({ text: { type: 'string' } }) },
  { name: 'big', description: 'a large result', inputSchema: obj() },
] }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const a = req.params.arguments ?? {};
  const text = (t) => ({ content: [{ type: 'text', text: t }] });
  switch (req.params.name) {
    case 'read_env': return text(`${a.name}=${process.env[a.name] ?? ''}; keys=${Object.keys(process.env).sort().join(',')}`);
    case 'key': return text(String(req.params._meta?.idempotencyKey ?? 'none'));
    case 'send_note': return text(`sent: ${a.text}`);
    case 'big': return text('x'.repeat(100 * 1024));
    default: return { content: [{ type: 'text', text: 'no such tool' }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
