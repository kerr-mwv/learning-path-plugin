/** The companion demo backend serves the integration like a real plugin.
 * Exercises the whole flow the way a host would: activate with a plugin
 * directory, call the registered handle operations, deactivate. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makePath } from "./fixtures.ts";
import { openLearningPathStore } from "../src/store.ts";
import { activate } from "../examples/companion-dummy/src/backend.ts";
import type { PluginBackendContext } from "learnharness-plugin-api";

const PATH_ID = "path-linear-algebra";

type Handler = (input: unknown) => unknown | Promise<unknown>;

/** The host-shaped slice the demo backend actually uses. */
function backendContext(t: { after: (fn: () => void) => void }, options: { dataDirectory: string }) {
  const handlers = new Map<string, Handler>();
  const controller = new AbortController();
  const ctx = {
    directory: path.join(options.dataDirectory, "community plugins", "learning-path-companion-demo", "dist"),
    dataDirectory: path.join(options.dataDirectory, "community plugins", "learning-path-companion-demo", "data"),
    signal: controller.signal,
    handle(name: string, handler: Handler) {
      if (handlers.has(name)) throw new Error(`Duplicate handle: ${name}`);
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
  } as unknown as PluginBackendContext;
  const cleanup = activate(ctx);
  t.after(() => {
    cleanup?.();
    controller.abort();
  });
  const call = (name: string, input?: unknown): Promise<any> => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`No handler: ${name}`);
    return Promise.resolve(handler(input));
  };
  return { call };
}

function directory(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "companion-demo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the companion demo serves a real Learning Path store, read-only", async (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  store.saveWorkspaceItem(
    PATH_ID,
    { kind: "note", title: "Eigenvector notes", addedBy: "learner", links: [{ to: "n-concept", rel: "grounds" }] },
    "Grounded note body.",
  );

  process.env.LP_COMPANION_DATA_DIR = dir;
  t.after(() => delete process.env.LP_COMPANION_DATA_DIR);
  const { call } = backendContext(t, { dataDirectory: dir });

  const overview = await call("demo.overview");
  assert.equal(overview.ok, true);
  assert.equal(overview.apiVersion, 1);
  assert.deepEqual(overview.capabilities, ["paths", "structure", "workspace", "errors", "pivots"]);
  assert.equal(overview.paths.length, 1);
  assert.equal(overview.paths[0].nodeCount, 6);
  assert.equal(overview.paths[0].openErrors, 1);
  assert.equal(overview.paths[0].pendingPivots, 1);

  const structure = await call("demo.structure", { pathId: PATH_ID });
  assert.equal(structure.ok, true);
  assert.deepEqual(structure.modules.map((module: any) => module.nodes.length), [3, 3]);
  const concept = structure.modules[0].nodes.find((node: any) => node.id === "n-concept");
  assert.equal(concept.items.length, 1);

  const notes = await call("demo.nodeNotes", { pathId: PATH_ID, nodeId: "n-concept" });
  assert.equal(notes.ok, true);
  assert.equal(notes.node.artifactType, "micro_code");
  assert.deepEqual(notes.notes, [
    { title: "Eigenvector notes", kind: "note", preview: "Grounded note body." },
  ]);
  assert.equal(notes.errors.length, 0);

  // Unknown paths and nodes are honest failures, never crashes.
  assert.equal((await call("demo.structure", { pathId: "nope" })).ok, false);
  assert.equal(
    (await call("demo.nodeNotes", { pathId: PATH_ID, nodeId: "nope" })).ok,
    false,
  );
  assert.throws(() => call("demo.structure", {}), /expects \{ pathId \}/);

  // Serving never changed the learner's store.
  assert.equal(store.readWorkspaceItemContent(PATH_ID, concept.items[0].id), "Grounded note body.");
  assert.equal(store.paths().length, 1);
});

test("the companion demo reports a missing store instead of failing", async (t) => {
  const dir = directory(t);
  process.env.LP_COMPANION_DATA_DIR = path.join(dir, "no-store");
  t.after(() => delete process.env.LP_COMPANION_DATA_DIR);
  const { call } = backendContext(t, { dataDirectory: dir });

  const overview = await call("demo.overview");
  assert.equal(overview.ok, false);
  assert.match(overview.error, /No Learning Path store found/);
});
