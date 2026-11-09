# git-store

Git objects without `git`, for the managed team store (ADR 0012, spec L9 section 3). A team kept in OrgCraft's own storage has real Git commits, so every version is a real commit SHA, and it leaves as a standard bundle that plain `git clone` opens.

- `node:crypto` and `node:zlib` only: no child processes (ADR 0008), no third-party code.
- Writes blobs, trees (modes `100644`, `100755` and folders only) and commits; whole-object version 2 packs; v2 bundles.
- Reads bundles and packs real Git wrote, deltas included (`OFS_DELTA`, `REF_DELTA`). Thin packs and incomplete bundles are refused.
- Every object read is hashed again, so a store that returns the wrong bytes is caught.
- `zip.mjs` writes the export archive.

A store is `{ get(sha), put(sha, framed), has(sha) }`, holding framed objects (`"<type> <len>\0<body>"`, uncompressed). `memoryStore()` is the in-process one; the server's object storage and `managed_objects` table come with L9b.

Tests: `tests/git-store.test.mjs` checks golden ids and, with the real `git` binary (tests only), runs `git fsck --strict` on what we write, clones our bundles, and reads bundles Git wrote.
