# team-model

The team as one JSON document (a **TeamSpec**, [schema](schema/team-spec.v1.json)) and the functions that convert a project layer (`.agent-team/`) to a TeamSpec and back. The CLI uses it today. The Studio server and editor will use the same module, so a team edited on a canvas and a team edited by hand are the same thing ([architecture §3](../../docs/product/architecture.md)).

```js
import { importLayer, compileLayer, resolveSpec, setEnabled, setField, setSection } from './index.mjs';
import { loadKit, readLayer, writeLayer } from './node.mjs';

const kit = loadKit();
const spec = importLayer(readLayer('.'), kit);   // every kit role, switched on or off, plus the project's own
setEnabled(spec, 'performance-tester', true);
setSection(spec, 'backend-dev', 'Rules', '- Every migration has a rollback note.');
writeLayer('.', compileLayer(spec, kit));        // then run scripts/agent-team/sync.sh
```

From the command line:

```sh
agent-team import > team-spec.json              # the layer as a TeamSpec
agent-team compile team-spec.json               # the TeamSpec back to .agent-team/, then sync
```

`index.mjs` is pure (no file system, no Node APIs), so it runs in a browser. `node.mjs` holds the file helpers.

**The contract:** building the team from `compileLayer(importLayer(layer))` writes the same generated files as building it from `layer`. `tests/team-model.test.mjs` checks this for every preset, every example and this repository's own team. A change that breaks it does not merge.

The optional data files are part of the model as `spec.ownership`, `spec.gates`, `spec.resources` and `spec.canvas` (`ownership.json`, `gates.json`, `resources.json`, `studio.json`). `validate(spec, kit)` (or `agent-team validate`) checks the whole team. `config.sh`, a hand-written `ownership.md` and the lane files are not part of a TeamSpec; they are carried through untouched.
