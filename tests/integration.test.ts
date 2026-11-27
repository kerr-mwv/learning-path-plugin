/** The companion integration reads a real Learning Path store, read-only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeItem, makePath, clone } from "./fixtures.ts";
import { STORE_SCHEMA_VERSION, openLearningPathStore, PATHS_DIRECTORY } from "../src/store.ts";
import { IntegrationError, SUPPORTED_STORE_SCHEMA_VERSION } from "../src/integration/api.ts";
import {
  createFileStoreIntegration,
  discoverLearningPathDataDirectory,
} from "../src/integration/reader.ts";

const PATH_ID = "path-linear-algebra";

function directory(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-integration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A populated store: the fixtures path plus two workspace notes, one linked
 * to a node, one free-floating. Written with the plugin's own store so the
 * integration is tested against genuine on-disk output. */
function populatedStore(dir: string) {
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const linked = store.saveWorkspaceItem(
    PATH_ID,
    { kind: "note", title: "Node notes on eigenvectors", addedBy: "learner", links: [{ to: "n-concept", rel: "grounds" }] },
    "# Eigenvectors\n\nGrounded notes.",
  );
  const floating = store.saveWorkspaceItem(
    PATH_ID,
    { kind: "note", title: "Floating", addedBy: "learner" },
    "Free-floating note.",
  );
  return { store, linked, floating };
}

test("the contract stays in lockstep with the plugin's store schema", () => {
  assert.equal(SUPPORTED_STORE_SCHEMA_VERSION, STORE_SCHEMA_VERSION);
});

test("discovers the sibling community plugin data directory", () => {
  const from = path.join("root", "community plugins", "some-companion", "dist");
  assert.equal(
    discoverLearningPathDataDirectory(from),
    path.resolve("root", "community plugins", "learning-path", "data"),
  );
});

test("serves paths, structure, workspace and watchpoints from a real store", (t) => {
  const dir = directory(t);
  const { linked, floating } = populatedStore(dir);
  const integration = createFileStoreIntegration({ dataDirectory: dir });

  assert.equal(integration.apiVersion, 1);
  assert.deepEqual(integration.getCapabilities(), ["paths", "structure", "workspace", "errors", "pivots"]);

  const paths = integration.listPaths();
  assert.equal(paths.length, 1);
  const summary = integration.getPath(PATH_ID);
  assert.ok(summary);
  assert.deepEqual(summary, paths[0]);
  assert.equal(summary!.title, "Linear algebra from canon");
  assert.equal(summary!.sourceMode, "canonical");
  assert.deepEqual(summary!.sourceTitles, ["OSTEP"]);
  assert.equal(summary!.moduleCount, 2);
  assert.equal(summary!.nodeCount, 6);
  assert.deepEqual(summary!.nodeStates, { unstarted: 3, in_progress: 2, consolidated: 1 });
  assert.equal(summary!.pendingPivotCount, 1);
  assert.equal(summary!.unresolvedErrorCount, 1);

  const modules = integration.listModules(PATH_ID);
  assert.deepEqual(modules?.map((module) => module.id), ["module-structure", "module-synthesis"]);
  assert.equal(modules?.[0]?.nodeCount, 3);

  const nodes = integration.listNodes(PATH_ID);
  assert.equal(nodes?.length, 6);
  assert.equal(nodes?.[0]?.moduleId, "module-structure");
  const scoped = integration.listNodes(PATH_ID, "module-structure");
  assert.equal(scoped?.length, 3);
  assert.equal(integration.listNodes(PATH_ID, "missing"), null);

  const concept = integration.getNode(PATH_ID, "n-concept");
  assert.ok(concept);
  assert.equal(concept!.type, "concept");
  assert.equal(concept!.progression, "in_progress");
  assert.equal(concept!.artifactType, "micro_code"); // per-node override
  assert.deepEqual(concept!.interleavesNodeIds, ["n-holistic"]);
  assert.deepEqual(concept!.childSessions, [
    { chatId: "chat-1", kind: "teaching", label: "First teaching chat", createdAt: makeItem().addedAt },
  ]);
  // Default artifact resolution: no per-node config falls back to the catalog.
  assert.equal(integration.getNode(PATH_ID, "n-contrast")?.artifactType, "retrieval_cue");
  assert.equal(integration.getNode(PATH_ID, "missing-node"), null);

  // Workspace: filter by node, by kind, and no filter.
  const nodeItems = integration.listWorkspaceItems(PATH_ID, { nodeId: "n-concept" });
  assert.deepEqual(nodeItems?.map((item) => item.id), [linked.id]);
  const all = integration.listWorkspaceItems(PATH_ID);
  assert.equal(all?.length, 2);
  assert.deepEqual(integration.listWorkspaceItems(PATH_ID, { kind: "note" }), all);
  assert.equal(integration.listWorkspaceItems("missing-path", {}), null);

  // Bounded content reads: one chunk covers the small fixture; a second call
  // past the end returns an empty chunk with no continuation.
  const chunk = integration.readWorkspaceItem(PATH_ID, linked.id, { maxBytes: 64 });
  assert.ok(chunk);
  assert.equal(chunk!.text, "# Eigenvectors\n\nGrounded notes.");
  assert.equal(chunk!.nextOffset, null);
  const tail = integration.readWorkspaceItem(PATH_ID, linked.id, { offset: 4096 });
  assert.deepEqual(tail, { text: "", nextOffset: null });
  assert.equal(integration.readWorkspaceItem(PATH_ID, floating.id)?.text, "Free-floating note.");
  assert.equal(integration.readWorkspaceItem(PATH_ID, "0f8fad5b-d9cb-469f-a165-70867728950e"), null);

  // Watchpoints: one unresolved error, one pending pivot, from the fixtures.
  const errors = integration.listOpenErrors(PATH_ID);
  assert.deepEqual(errors?.map((error) => error.id), ["err-skill"]);
  assert.equal(errors?.[0]?.nodeId, "n-skill");
  assert.equal(errors?.[0]?.category, "procedural_slip");
  assert.equal(errors?.[0]?.sessionChatId, "chat-1");
  assert.equal(integration.listOpenErrors(PATH_ID, "n-holistic")?.length, 0);

  const pivots = integration.listPendingPivots(PATH_ID);
  assert.deepEqual(pivots?.map((pivot) => pivot.id), ["pivot-skill"]);
  assert.equal(pivots?.[0]?.proposalType, "skill");
  assert.equal(pivots?.[0]?.nodeId, "n-skill");
});

test("bounded reads split long content across UTF-8-safe chunks", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const marker = "é—multi-byte—"; // every marker forces UTF-8 continuation bytes
  const content = `${marker.repeat(64)}END`;
  const saved = store.saveWorkspaceItem(PATH_ID, { kind: "note", title: "Long", addedBy: "learner" }, content);

  const integration = createFileStoreIntegration({ dataDirectory: dir });
  const maxBytes = 100; // deliberately splits markers mid-character
  let offset: number | null = 0;
  let reassembled = "";
  let calls = 0;
  while (offset !== null && calls < 1000) {
    const chunk = integration.readWorkspaceItem(PATH_ID, saved.id, { offset, maxBytes });
    assert.ok(chunk);
    reassembled += chunk!.text;
    offset = chunk!.nextOffset;
    calls += 1;
  }
  assert.equal(reassembled, content);
  assert.ok(calls > 1);
});

test("chunked reads never serve a source-kind item's content", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const uploaded = store.saveSource({ name: "Axler chapters 1-3", markdown: "# Linear Algebra Done Right" });
  const source = store.saveWorkspaceItem(
    PATH_ID,
    { kind: "source", title: "Uploaded book", addedBy: "learner", sourceId: uploaded.reference.sourceId },
  );
  const integration = createFileStoreIntegration({ dataDirectory: dir });
  const items = integration.listWorkspaceItems(PATH_ID, { kind: "source" });
  assert.equal(items?.length, 1);
  assert.equal(items?.[0]?.sourceId, uploaded.reference.sourceId);
  assert.equal(integration.readWorkspaceItem(PATH_ID, source.id), null);
});

test("a missing store reports itself instead of guessing", (t) => {
  const dir = directory(t);
  const integration = createFileStoreIntegration({ dataDirectory: path.join(dir, "nope") });
  assert.deepEqual(integration.getCapabilities(), []);
  assert.throws(() => integration.listPaths(), (error: unknown) => {
    assert.ok(error instanceof IntegrationError);
    assert.equal(error.code, "storeNotFound");
    return true;
  });
});

test("a newer store schema fails loud as unsupportedVersion", (t) => {
  const dir = directory(t);
  populatedStore(dir);
  const filename = path.join(dir, PATHS_DIRECTORY, `${PATH_ID}.json`);
  const envelope = JSON.parse(fs.readFileSync(filename, "utf8"));
  envelope.schemaVersion = STORE_SCHEMA_VERSION + 1;
  fs.writeFileSync(filename, JSON.stringify(envelope));

  const integration = createFileStoreIntegration({ dataDirectory: dir });
  assert.throws(() => integration.listPaths(), (error: unknown) => {
    assert.ok(error instanceof IntegrationError);
    assert.equal(error.code, "unsupportedVersion");
    return true;
  });
});

test("corrupt records fail loud, and unknown paths read as null", (t) => {
  const dir = directory(t);
  populatedStore(dir);
  const integration = createFileStoreIntegration({ dataDirectory: dir });

  // Unknown paths and nodes are null returns, not errors.
  assert.equal(integration.getPath("missing-path"), null);
  assert.equal(integration.listModules("missing-path"), null);
  assert.equal(integration.getNode("missing-path", "n-concept"), null);

  // Corrupt JSON in one record makes listing loud, not silently partial.
  const filename = path.join(dir, PATHS_DIRECTORY, `${PATH_ID}.json`);
  fs.writeFileSync(filename, "{ not json");
  assert.throws(() => integration.listPaths(), (error: unknown) => {
    assert.ok(error instanceof IntegrationError);
    assert.equal(error.code, "corruptRecord");
    return true;
  });

  // Invalidated record content (validation failure) is corrupt, not partial.
  fs.writeFileSync(
    filename,
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      path: { ...clone(makePath()), goal: 42 },
    }),
  );
  assert.throws(() => integration.getPath(PATH_ID), (error: unknown) => {
    assert.ok(error instanceof IntegrationError);
    assert.equal(error.code, "corruptRecord");
    return true;
  });
});

test("refuses symlinked store files and traversal-shaped ids", (t) => {
  const dir = directory(t);
  populatedStore(dir);
  const integration = createFileStoreIntegration({ dataDirectory: dir });

  assert.throws(() => integration.getPath("../escape"), (error: unknown) => {
    assert.ok(error instanceof IntegrationError);
    return true;
  });
  assert.throws(() => integration.readWorkspaceItem(PATH_ID, "../../etc/passwd"), (error: unknown) => {
    assert.ok(error instanceof IntegrationError);
    return true;
  });

  // A symlinked path record is refused exactly like the store refuses it.
  const real = path.join(dir, "real-record.json");
  fs.writeFileSync(real, JSON.stringify({ schemaVersion: 1, revision: 1, path: makePath() }));
  fs.rmSync(path.join(dir, PATHS_DIRECTORY, `${PATH_ID}.json`));
  fs.symlinkSync(real, path.join(dir, PATHS_DIRECTORY, `${PATH_ID}.json`));
  assert.throws(() => integration.getPath(PATH_ID), (error: unknown) => {
    assert.ok(error instanceof IntegrationError);
    assert.equal(error.code, "corruptRecord");
    return true;
  });
});

test("drops workspace links to nodes the path no longer has, like the store", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const stale = store.saveWorkspaceItem(
    PATH_ID,
    { kind: "note", title: "Stale link", addedBy: "learner", links: [{ to: "n-contrast", rel: "grounds" }] },
    "content",
  );
  // The path is later edited without that node (interleave references too).
  const next = {
    ...clone(makePath()),
    modules: makePath().modules.map((module) => ({
      ...module,
      nodes: module.nodes
        .filter((node) => node.id !== "n-contrast")
        .map((node) => ({
          ...node,
          interleavesNodeIds: node.interleavesNodeIds.filter((id) => id !== "n-contrast"),
        })),
    })),
  };
  store.savePath(next);

  // The store keeps the item but drops the dead link at read; so must we.
  const integration = createFileStoreIntegration({ dataDirectory: dir });
  const items = integration.listWorkspaceItems(PATH_ID);
  const item = items?.find((candidate) => candidate.id === stale.id);
  assert.ok(item);
  assert.deepEqual(item!.links, []);
  // And the note's content survives the edit, still readable.
  assert.equal(integration.readWorkspaceItem(PATH_ID, stale.id)?.text, "content");
  // It is not reported as linked to the removed node.
  assert.deepEqual(integration.listWorkspaceItems(PATH_ID, { nodeId: "n-contrast" }), []);
});
