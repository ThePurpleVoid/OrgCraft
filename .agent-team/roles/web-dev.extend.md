## Owns (writes) (replace)
apps/studio/ (the visual team builder: canvas, palette, inspector, publish and chat screens). The dashboard page in tools/dashboard/ is the kit core dev's; ask for changes there.

## Rules
- The canvas edits the team model from `packages/team-model/`, never `.agent-team/` files directly. Publish is the only path from the canvas to a repository.
