# ADR 0003: the local Studio is plain ES modules with no build step

Status: accepted, 2026-11-06. Owner: architect (web dev implements).

## Context

The architecture plans the Studio editor on React, React Flow and Vite. The kit, though, ships with `npx github:PurpleGiragge/Agent-Team-Kit#vX`: no install step, no build step, no dependencies. That is how every team on the kit runs it today, and the dashboard already works this way. A Vite build would mean either committing built files or publishing to npm before anyone can open the editor.

## Decision

Phase 2's local editor (`apps/studio/`) is a small Node `http` server and one page written as plain ES modules, with no dependencies. The page imports the team model (`packages/team-model/index.mjs`) directly, so the checks a user sees while editing are the same code that `agent-team validate` and sync run. The org chart is SVG drawn by hand, with its own layout (lanes for small subtrees, side by side for managers of managers).

## Consequences

- `npx github:…#v0.7.1 studio` works anywhere Node 18 does, offline after the first fetch, and nothing has to be built or published first.
- We give up React Flow's pan and zoom, minimap and edge routing. The canvas has fit-to-width zoom and drag to re-parent, which covers demo steps 2 to 7. Flow and Systems views, and the live board overlay, are still to come.
- The hosted Studio (phase 4) can still move to React and React Flow behind the same TeamSpec and the same `/api` shapes (`state`, `preview`, `publish`). If it does, this local editor is replaced, not maintained in parallel.
- The server binds to 127.0.0.1 by default and only accepts same-origin JSON posts, so a web page the user visits cannot drive it to write to the repository.
