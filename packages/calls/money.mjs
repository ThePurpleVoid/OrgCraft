// Money in whole minor units: one copy for the control plane and the Studio page (code review L22m). The file lives
// next to the page, which the Studio serves as ./money.mjs; the server and the other packages import it from here.
// The runner image does not copy apps/studio/, so the runner must not import this (or rules.mjs) without adding it to
// apps/runner/Dockerfile: tests/runner-image-files.test.mjs fails if it does.
export * from '../../apps/studio/public/money.mjs';
