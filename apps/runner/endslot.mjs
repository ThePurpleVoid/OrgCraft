// The end-of-session clean-up, run as a child of the runner (sandbox.mjs reapAside) so its synchronous work never
// stalls the runner's event loop. Input on stdin: { slot, leaves, park }; output: reap's { ok, problems } as JSON.
import { park, reap } from './sandbox.mjs';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const { slot, leaves = [], park: dir = null } = JSON.parse(input);
const r = reap(slot, leaves, { stopped: () => dir && park(dir) });
process.stdout.write(JSON.stringify(r) + '\n');
