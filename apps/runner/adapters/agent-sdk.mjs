// The first runtime adapter: the Claude Agent SDK (Claude Code as a library). One `turn` is one query(): it resumes
// the role's conversation, gives it the team tool server in process, and puts every tool call through the
// supervisor's policy in a PreToolUse hook, so ownership and approvals are enforced by the runner, not the prompt.
// The SDK is loaded on first use, so the runner and its tests start without it.
import { estimate } from '../../../packages/model-prices/index.mjs';
import { loadPrices } from '../../../packages/model-prices/node.mjs';
let sdk = null;
const load = async () => (sdk ??= await import('@anthropic-ai/claude-agent-sdk'));

/** One approval can take hours: the hook waits as long as a person does. */
const PRICES = loadPrices();
/** The listed model with the highest output price: what an unlisted model's turn is counted at. */
const DEAREST = Object.entries(PRICES.models).sort(([, a], [, b]) => b.outputPerMTok - a.outputPerMTok || b.inputPerMTok - a.inputPerMTok)[0][0];
const HOOK_TIMEOUT_S = 7 * 24 * 3600;

/**
 * What a turn cost, in USD, for the budget; never zero for a turn that used tokens (the budget must not fail open).
 * The SDK's reported cost is what was spent, for a model the shared table lists. When the SDK reports none, or
 * zero for a turn that used tokens, the list price from the table. A model the table does not list is counted at
 * the dearest listed model, and at least that even when the SDK reports a cost (it may not know the model's price
 * either, and report it as free).
 */
export function turnCost(model, result) {
  const u = result?.usage ?? {};
  const counts = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cacheReadTokens: u.cache_read_input_tokens ?? 0, cacheWriteTokens: u.cache_creation_input_tokens ?? 0 };
  const listed = estimate({ model, ...counts }, PRICES).usd;
  const list = listed ?? estimate({ model: DEAREST, ...counts }, PRICES).usd;
  const sdk = typeof result?.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd) && result.total_cost_usd > 0 ? result.total_cost_usd : null;
  if (sdk === null) return list;
  return listed === null ? Math.max(sdk, list) : sdk;
}

/** The team tools as Agent SDK tool definitions; each call goes to the session's checked `callTool`. */
export function teamToolDefinitions(tool, tools, callTool) {
  return tools.map((t) => tool(t.name, t.description, t.shape, async (args) => {
    const r = await callTool(t.name, args);
    return { content: [{ type: 'text', text: r.text }], isError: r.isError === true };
  }));
}

import { sandboxSpawn } from '../sandbox.mjs';

export function agentSdkAdapter({ effort, settingSources = [], executable, sdk: given } = {}) {
  // settingSources is empty by default (security review R3): a branch's own .claude settings, hooks, env and
  // .mcp.json could otherwise run code or redirect the model key outside the runner's policy.
  return {
    runtime: 'agent-sdk',
    async turn(o) {
      // The model key comes only from the runner's own environment (passed in o.env). Without one, refuse rather
      // than let the SDK fall back on whatever credentials the machine happens to have: spending is the owner's call.
      if (!o.env?.ANTHROPIC_API_KEY || !o.env?.ANTHROPIC_BASE_URL) throw new Error('no model key: set ANTHROPIC_API_KEY in the runner\'s environment (sessions reach the model through the runner\'s proxy)');
      const { query, createSdkMcpServer, tool } = given ?? (await load());
      // Tool names reach the model as mcp__team__<name>; policy.mjs lets that prefix through to the field checks.
      const team = createSdkMcpServer({
        name: 'team',
        version: '1',
        instructions: 'The team protocols as tools. Every report and message between roles goes through these.',
        tools: teamToolDefinitions(tool, o.tools, o.callTool),
      });
      const guard = async (input) => {
        if (input.hook_event_name !== 'PreToolUse') return {};
        const d = await o.preToolUse(input.tool_name, input.tool_input ?? {});
        // An approved call runs as signed (ADR 0013): the policy hands back the signed input, which replaces the model's.
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.allow ? 'allow' : 'deny', permissionDecisionReason: d.allow ? 'allowed by the team policy' : d.reason, ...(d.allow && d.input ? { updatedInput: d.input } : {}) } };
      };
      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true });

      const q = query({
        prompt: o.prompt,
        options: {
          cwd: o.cwd,
          env: o.env,
          model: o.model,
          ...(effort ? { effort } : {}),
          systemPrompt: { type: 'preset', preset: 'claude_code', append: o.systemPrompt },
          ...(o.resume && !String(o.resume).startsWith('stub-') ? { resume: o.resume } : {}),
          mcpServers: { ...o.mcp, team },
          hooks: { PreToolUse: [{ hooks: [guard], timeout: HOOK_TIMEOUT_S }] },
          // Anything the hook did not settle is decided by the same policy.
          canUseTool: async (name, input) => {
            const d = await o.preToolUse(name, input);
            return d.allow ? { behavior: 'allow', updatedInput: d.input ?? input } : { behavior: 'deny', message: d.reason };
          },
          settingSources,
          ...(o.maxBudgetUsd !== undefined ? { maxBudgetUsd: o.maxBudgetUsd } : {}),
          ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
          // In the container, Claude Code (and every command it runs) starts as the agent user (F3).
          ...(o.sandbox ? { spawnClaudeCodeProcess: sandboxSpawn(o.sandbox) } : {}),
          abortController,
        },
      });
      let resume = o.resume, result = '', usage = {}, stop = 'end', error;
      try {
        for await (const m of q) {
          if (m.type === 'system' && m.subtype === 'init' && m.session_id) resume = m.session_id;
          // Each completed assistant text block (the front door's replies go to the chat; see session.say).
          if (m.type === 'assistant' && !m.parent_tool_use_id) for (const c of m.message?.content ?? []) if (c.type === 'text' && c.text) await o.onText?.(c.text);
          if (m.type === 'result') {
            resume = m.session_id ?? resume;
            usage = { inputTokens: (m.usage?.input_tokens ?? 0) + (m.usage?.cache_read_input_tokens ?? 0) + (m.usage?.cache_creation_input_tokens ?? 0), outputTokens: m.usage?.output_tokens ?? 0, costUsd: turnCost(o.model, m) };
            if (m.subtype === 'success') result = m.result ?? '';
            else { stop = m.subtype === 'error_max_budget_usd' ? 'budget' : 'error'; error = m.subtype; }
          }
        }
      } catch (e) {
        if (!abortController.signal.aborted) throw e;
        stop = 'aborted';
      } finally {
        o.signal.removeEventListener('abort', onAbort);
      }
      return { resume, usage, stop, result, error };
    },
  };
}
