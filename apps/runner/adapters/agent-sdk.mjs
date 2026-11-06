// The first runtime adapter: the Claude Agent SDK (Claude Code as a library). One `turn` is one query(): it resumes
// the role's conversation, gives it the team tool server in process, and puts every tool call through the
// supervisor's policy in a PreToolUse hook, so ownership and approvals are enforced by the runner, not the prompt.
// The SDK is loaded on first use, so the runner and its tests start without it.
let sdk = null;
const load = async () => (sdk ??= await import('@anthropic-ai/claude-agent-sdk'));

/** One approval can take hours: the hook waits as long as a person does. */
const HOOK_TIMEOUT_S = 7 * 24 * 3600;

/** The team tools as Agent SDK tool definitions; each call goes to the session's checked `callTool`. */
export function teamToolDefinitions(tool, tools, callTool) {
  return tools.map((t) => tool(t.name, t.description, t.shape, async (args) => {
    const r = await callTool(t.name, args);
    return { content: [{ type: 'text', text: r.text }], isError: r.isError === true };
  }));
}

export function agentSdkAdapter({ effort, settingSources = ['project'], executable } = {}) {
  return {
    runtime: 'agent-sdk',
    async turn(o) {
      // The model key comes only from the runner's own environment (passed in o.env). Without one, refuse rather
      // than let the SDK fall back on whatever credentials the machine happens to have: spending is the owner's call.
      if (!o.env?.ANTHROPIC_API_KEY) throw new Error('no model key: set ANTHROPIC_API_KEY in the runner\'s environment');
      const { query, createSdkMcpServer, tool } = await load();
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
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.allow ? 'allow' : 'deny', permissionDecisionReason: d.allow ? 'allowed by the team policy' : d.reason } };
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
            return d.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: d.reason };
          },
          settingSources,
          ...(o.maxBudgetUsd !== undefined ? { maxBudgetUsd: o.maxBudgetUsd } : {}),
          ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
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
            usage = { inputTokens: (m.usage?.input_tokens ?? 0) + (m.usage?.cache_read_input_tokens ?? 0) + (m.usage?.cache_creation_input_tokens ?? 0), outputTokens: m.usage?.output_tokens ?? 0, costUsd: m.total_cost_usd ?? 0 };
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
