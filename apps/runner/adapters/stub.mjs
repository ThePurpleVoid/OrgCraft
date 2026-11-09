// A stub model for tests and dry runs: a script per role plays the model's part. It calls the team tools and the
// built-in tools through exactly the paths a real session uses (the field checks, the ownership and approval
// policy, the tool server), so a test exercises the runner, not a copy of it. No model, no network, no cost.
export function stubAdapter(script, { costUsd = 0.0123 } = {}) {
  const turns = new Map();
  let uses = 0;
  return {
    runtime: 'stub',
    async turn(o) {
      const n = (turns.get(o.session) ?? 0) + 1;
      turns.set(o.session, n);
      const play = script[o.role] ?? script['*'];
      const t = {
        role: o.role, turn: n, prompt: o.prompt, systemPrompt: o.systemPrompt, cwd: o.cwd, model: o.model, env: o.env, signal: o.signal, maxBudgetUsd: o.maxBudgetUsd,
        call: (name, args) => o.callTool(name, args),
        /** A built-in tool call: the policy decides first; `run` is what the tool would do when allowed. */
        use: async (tool, input, run, { id = `tu_${++uses}` } = {}) => {
          const d = await o.preToolUse(tool, input, { id });
          if (!d.allow) return { refused: d.reason };
          // What runs is what the policy hands back (an approved call's signed input), as under the Agent SDK.
          const ran = d.input ?? input;
          const value = run ? await run(ran) : undefined;
          // The tool's response as the Agent SDK's PostToolUse hook would see it (a run may return { is_error: true }).
          await o.postToolUse?.(tool, ran, value ?? null, { id });
          return { ok: true, value };
        },
        /** A completed assistant text block. */
        say: (text) => o.onText?.(text),
      };
      const r = (play ? await play(t) : null) ?? {};
      return {
        resume: o.resume ?? `stub-${o.session}`,
        usage: r.usage ?? { inputTokens: 1000, outputTokens: 200, costUsd },
        stop: o.signal.aborted ? 'aborted' : 'end',
        result: r.result ?? '',
      };
    },
  };
}
