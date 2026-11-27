# Learning Path Companion Demo

A deliberately tiny third-party plugin that proves the **Learning Path
integration API v1** works end-to-end: it finds the Learning Path store,
serves paths, modules, nodes, workspace notes, error watchpoints and pending
pivots through the read-only contract, and renders everything it can see.

This is a developer example, not a product. Read its two source files first:

- `src/backend.ts` — the interesting half. Discovers the Learning Path data
  directory from its own `ctx.directory` (community plugins are siblings:
  `community plugins/<id>/dist` + `data`), opens
  `createFileStoreIntegration`, and exposes three `ctx.handle` operations.
- `src/main.ts` — a plain view that calls those operations and prints what
  came back.

The integration module itself lives in the Learning Path plugin repo at
`src/integration/api.ts` (the contract) and `src/integration/reader.ts` (the
file-store implementation) and is bundled in at build time. A real companion
would import a published `learning-path-plugin-api` package instead; the
contract is identical.

## What it exercises

| Contract call | Demo operation |
| :--- | :--- |
| `getCapabilities()`, `listPaths()`, `listOpenErrors()`, `listPendingPivots()` | `demo.overview` |
| `listModules()`, `listNodes()`, `listWorkspaceItems({ nodeId })` | `demo.structure` |
| `getNode()`, `listOpenErrors(nodeId)`, `readWorkspaceItem()` (bounded, 1 KiB preview) | `demo.nodeNotes` |

Everything is read-only. The demo never writes to the Learning Path store,
and anything a real companion produced would belong in *its own*
`ctx.dataDirectory`, joined by the stable path/node/chat ids the contract
exposes.

## Building and installing

From this directory (requires the repo's `node_modules`, esbuild included):

```sh
node scripts/build.mjs
```

Then copy the built package into your LearnHarness community plugins
directory, next to `learning-path`:

```sh
# LearnHarness data → community plugins/
rsync -a dist/ "<learnharness-data>/community plugins/learning-path-companion-demo/dist/"
# or use the repo's installer pattern from the project root, adapting the path.
```

Both plugins must sit as siblings, because discovery is
`path.resolve(ctx.directory, "..", "..", "learning-path", "data")`. To point
the demo at a store elsewhere (e.g. a copy), set `LP_COMPANION_DATA_DIR`.

## Testing it live

1. Install and enable the Learning Path plugin; create a path (and ideally a
   couple of workspace notes linked to nodes).
2. Enable **Learning Path Companion Demo** and open **LP Companion Demo**
   from the sidebar.
3. Expect: the integration version, the resolved store path, capabilities,
   then your paths as buttons → modules and their nodes → per-node notes
   with a bounded preview, open errors and pending pivots.
4. Without a Learning Path store (or with no path created yet), the view
   says so plainly — that is the contract's `storeNotFound` / empty-list
   behavior, not a crash.

The contract's hard guarantees are tested in the main repo:
`npm test` runs `tests/integration.test.ts` against a real store written by
the plugin's own persistence layer, including corrupt records, newer store
schemas, symlink refusal and UTF-8-safe bounded reads.
