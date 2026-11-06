# Work contract, `work/1`

The core of the product does not assume that work is code ([ADR 0005](../adr/0005-online-first-built-to-last.md) §8). A team works in a **workspace store** reached through a connector. Every store implements the same five verbs. The **repository connector** (Git and GitHub) is the first implementation, and it is how every engineering team on the kit already works.

| Verb | Meaning | Repository connector |
| --- | --- | --- |
| `area(pattern)` | A part of the store with exactly one writer role | A path pattern: `repo:apps/web/**` (owned areas, `ownership.json`) |
| `check(name)` | Something that must pass before a change is accepted: a command, a checklist, a reviewer role, a human approval, or a connector call that returns pass or fail | A step in `gates.json` or `config.sh`, run by `merge-gate.sh` |
| `propose(change)` | Put a change up for review without applying it | A branch and a pull request |
| `accept(proposal)` | Apply a proposal once its checks pass and the policy allows it | Merge, behind approval, SIGNOFF, green checks and no conflicts |
| `evidence(link)` | An artefact that shows something was done or verified | Screenshots, logs, preview URLs, CI runs |

A connector declares the verbs it supports in its manifest (`work` capability, [connectors.md](connectors.md)). The policy (the owner-steps-in list, per role pack) decides which `accept` calls need a person.
