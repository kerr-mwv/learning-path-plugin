# Companion API v1 — exposing Learning Path data to other plugins

LearnHarness plugin API v1 has no cross-plugin calls: `ctx.handle` bridges
are frontend-only, `ctx.events.emit` is plugin-scoped, and each plugin owns
its data directory. The Learning Path plugin therefore exposes a companion
surface as a **typed, versioned, read-only contract over its store**,
implemented by a small file-store reader that companion backends bundle.
The host API's "trusted Node code" posture makes this safe; the Learning
Path store's atomic tmp+rename writes make it race-free.

## Where it lives

| Piece | Path |
| :--- | :--- |
| Contract (self-contained types, no imports) | `src/integration/api.ts` |
| File-store implementation + discovery | `src/integration/reader.ts` |
| Tests against a real store | `tests/integration.test.ts` |
| Working demo companion plugin | `examples/companion-dummy/` |

## The surface

```ts
interface LearningPathIntegration {
  readonly apiVersion: 1;
  getCapabilities(): readonly LearningPathCapability[]; // paths, structure, workspace, errors, pivots
  listPaths(): readonly LearningPathSummary[];
  getPath(pathId): LearningPathSummary | null;
  listModules(pathId): readonly ModuleSummary[] | null;
  listNodes(pathId, moduleId?): readonly NodeSummary[] | null;
  getNode(pathId, nodeId): NodeDetail | null;
  listWorkspaceItems(pathId, { nodeId?, kind? }): readonly WorkspaceItemRef[] | null;
  readWorkspaceItem(pathId, itemId, { offset?, maxBytes? }): { text, nextOffset } | null;
  listOpenErrors(pathId, nodeId?): readonly OpenErrorRef[] | null;
  listPendingPivots(pathId): readonly PendingPivotRef[] | null;
}
```

A companion opens it from its backend activation:

```ts
const integration = createFileStoreIntegration({
  // community plugins/<id>/dist → sibling learning-path/data
  dataDirectory: discoverLearningPathDataDirectory(ctx.directory),
});
```

## Guarantees

- **Read-only.** The reader never opens `openLearningPathStore` (it owns
  migrations and writes); it reads only the documents the store layout
  defines and reuses the plugin's own domain validators for identical
  strictness. Companions write anything they produce to their own
  `ctx.dataDirectory`, joined by the stable ids the contract exposes.
- **Fail loud, not partial.** A missing store throws
  `storeNotFound`; a record with a different `schemaVersion` throws
  `unsupportedVersion` (never a guess from newer data); corrupt JSON or
  invalid records throw `corruptRecord`. Unknown paths/nodes are `null`.
- **Never a torn read.** Store writes are atomic renames; readers always
  observe a complete previous or next version. Re-read on host events
  (there is no cross-plugin push; subscriptions would need a host
  feature).
- **Bounded content.** `readWorkspaceItem` serves Markdown in UTF-8-safe
  chunks (default 32 KiB, capped at 256 KiB, never splitting a multibyte
  character), mirroring the plugin's own chunked viewer. Source-kind items
  are metadata-only; their content belongs to the sources store.
- **Same view as the plugin.** Dead workspace links are dropped at read
  exactly as the plugin's store does; summaries count states, errors and
  pivots exactly as the plugin's overview does.
- **Traversal-safe.** Ids are pattern-checked before path joins and
  symlinked store files are refused, mirroring the store's own posture.

## Versioning

- `INTEGRATION_API_VERSION` bumps are breaking; new capabilities may be
  added within a version, so consult `getCapabilities()` rather than
  assuming the list.
- `SUPPORTED_STORE_SCHEMA_VERSION` in `src/integration/api.ts` must stay in
  lockstep with `STORE_SCHEMA_VERSION` in `src/store.ts`
  (`tests/integration.test.ts` asserts this).
- Companions should pin the contract version and treat
  `unsupportedVersion` as "the Learning Path plugin was upgraded; ask the
  learner to update this companion."

## Non-goals

- **Writes** into the Learning Path store — including progression,
  error-ledger entries, pivots and workspace items. Those flow through the
  plugin's own operations only.
- **Subscriptions.** Poll on host events and re-read; a host-mediated
  plugin bridge (namespaced events or cross-plugin calls) would be the
  proper future home for `"subscribe"`.
- **Architect conversations, settings internals and source file bodies**
  are never exposed.

## Try it

`examples/companion-dummy/` is a complete, installable companion that
serves every capability and renders what it found — see its README.
