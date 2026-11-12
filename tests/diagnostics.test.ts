/** Backend tests for diagnostics, pivots and settings.
 *
 * The real backend activation runs against the in-process host and a temporary
 * data directory. These tests cover:
 * - watchpoint propagation across interleaved and upstream nodes;
 * - Error Ledger resolution/notes writes;
 * - advisory pivot accept/dismiss transitions and the inserted repair node;
 * - settings validation, persistence and Architect model preference;
 * - non-destructive path deletion (plugin records only, orphaned uploads only).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatRecord } from "learnharness-plugin-api";
import type { LearningPath, PathNode } from "../src/domain.ts";
import { buildChildSessionBrief, collectErrorWatchpoints } from "../src/framework.ts";
import { openLearningPathStore } from "../src/store.ts";
import { SOURCES_DIRECTORY } from "../src/store.ts";
import { AT, anchor, makeNode, makePath } from "./fixtures.ts";
import { createHost } from "./host.ts";
import type { TestHost } from "./host.ts";

interface ToolResult {
  content: { type: string; text: string }[];
  details: any;
  isError?: boolean;
}

function temporaryDirectory(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-q6-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function host(t: { after: (fn: () => void) => void }, options: Parameters<typeof createHost>[0] = {}): TestHost {
  const created = createHost(options);
  t.after(() => created.close());
  return created;
}

async function createConversation(h: TestHost): Promise<string> {
  const result = await h.call<{ conversation: { id: string } }>("architect.create");
  return result.conversation.id;
}

async function savePath(h: TestHost, value: unknown): Promise<ToolResult> {
  const result = await h.runTool<ToolResult>("save_learning_path", value);
  assert.equal(result.isError, undefined, result.details?.error);
  return result;
}

function errorEntry(id: string, summary: string, category: PathNode["errors"][number]["category"] = "misconception") {
  return {
    id,
    category,
    summary,
    resolved: false,
    createdAt: AT,
  };
}

function pathWithNodes(nodes: readonly PathNode[], overrides: Partial<LearningPath> = {}): LearningPath {
  return {
    id: "path-watchpoints",
    title: "Watchpoint propagation",
    goal: "Prove unresolved errors follow later nodes.",
    createdAt: AT,
    updatedAt: AT,
    sourceSpine: {
      mode: "canonical",
      references: [{ title: "OSTEP", kind: "textbook" }],
    },
    modules: [{ id: "module-main", title: "Main", nodes }],
    ...overrides,
  };
}

function uploadedPath(id: string, source: {
  sourceId: string;
  name: string;
  uploadedAt: string;
  byteSize?: number;
  sha256?: string;
}): LearningPath {
  return pathWithNodes(
    [
      makeNode("n-only", "concept", {
        sourceAnchor: anchor("Uploaded notes"),
        childSessions: [{ chatId: "chat-keep", kind: "teaching", createdAt: AT, label: "Kept chat" }],
      }),
    ],
    {
      id,
      title: `Uploaded path ${id}`,
      goal: "Follow the uploaded corpus.",
      sourceSpine: { mode: "uploaded", sources: [source] },
    },
  );
}

test("unresolved watchpoints propagate across interleaved and upstream nodes", () => {
  const first = makeNode("n-first", "concept", {
    errors: [errorEntry("err-first", "Confuses the map with the territory.", "misconception")],
  });
  const second = makeNode("n-second", "contrast", {
    interleavesNodeIds: ["n-first"],
    errors: [errorEntry("err-second", "Mixes up the boundary case.", "discrimination_error")],
  });
  const third = makeNode("n-third", "skill", {
    interleavesNodeIds: ["n-second"],
    errors: [errorEntry("err-third", "Drops a sign while expanding.", "procedural_slip")],
  });
  const path = pathWithNodes([first, second, third]);

  // Own errors first, then the interleaved predecessor, then nearest upstream.
  assert.deepEqual(
    collectErrorWatchpoints(path, "n-third").map((watchpoint) => watchpoint.entry.id),
    ["err-third", "err-second", "err-first"],
  );
  assert.deepEqual(
    collectErrorWatchpoints(path, "n-second").map((watchpoint) => watchpoint.entry.id),
    ["err-second", "err-first"],
  );

  const brief = buildChildSessionBrief({ path, nodeId: "n-third", kind: "teaching" });
  assert.deepEqual(
    brief.watchpoints.map((watchpoint) => watchpoint.entry.id),
    ["err-third", "err-second", "err-first"],
  );
  assert.match(brief.text, /Mixes up the boundary case/);
  assert.match(brief.text, /Confuses the map with the territory/);
  assert.match(brief.text, /verify quietly whether the repair held/);

  // Resolving the upstream error stops it travelling forward.
  const resolved: LearningPath = {
    ...path,
    modules: path.modules.map((module) => ({
      ...module,
      nodes: module.nodes.map((node) =>
        node.id === "n-first"
          ? {
              ...node,
              errors: node.errors.map((entry) => ({
                ...entry,
                resolved: true,
                resolvedAt: AT,
              })),
            }
          : node,
      ),
    })),
  };
  assert.deepEqual(
    collectErrorWatchpoints(resolved, "n-third").map((watchpoint) => watchpoint.entry.id),
    ["err-third", "err-second"],
  );
  assert.throws(() => collectErrorWatchpoints(path, "missing"), /unknown node id/);
});

test("errors.update resolves, reopens and annotates one ledger entry", async (t) => {
  const h = host(t);
  await createConversation(h);
  await savePath(h, makePath());

  const resolved = await h.call<{ path: LearningPath; error: PathNode["errors"][number] }>(
    "errors.update",
    {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      errorId: "err-skill",
      resolved: true,
      notes: "Track the sign on every expansion step.",
    },
  );
  assert.equal(resolved.error.resolved, true);
  assert.ok(resolved.error.resolvedAt);
  assert.equal(resolved.error.notes, "Track the sign on every expansion step.");

  const reloaded = await h.call<{ path: LearningPath }>("paths.get", { id: "path-linear-algebra" });
  const entry = reloaded.path.modules[0]!.nodes.find((node) => node.id === "n-skill")!.errors[0]!;
  assert.equal(entry.resolved, true);
  assert.ok(entry.resolvedAt);
  assert.equal(entry.notes, "Track the sign on every expansion step.");
  assert.equal(
    h.events.filter((event) => event.topic === "paths-changed").at(-1)?.data &&
      (h.events.filter((event) => event.topic === "paths-changed").at(-1)!.data as { errorId?: string }).errorId,
    "err-skill",
  );

  const reopened = await h.call<{ path: LearningPath; error: PathNode["errors"][number] }>(
    "errors.update",
    {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      errorId: "err-skill",
      resolved: false,
      notes: null,
    },
  );
  assert.equal(reopened.error.resolved, false);
  assert.equal(reopened.error.resolvedAt, undefined);
  assert.equal(reopened.error.notes, undefined);
  assert.equal(reopened.error.summary, "Drops a sign while expanding.", "the original diagnosis is preserved");

  await assert.rejects(
    h.call("errors.update", { pathId: "path-linear-algebra", nodeId: "n-skill", errorId: "err-skill" }),
    /needs resolved or notes/,
  );
  await assert.rejects(
    h.call("errors.update", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      errorId: "err-skill",
      resolved: "yes",
    }),
    /resolved must be a boolean/,
  );
  await assert.rejects(
    h.call("errors.update", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      errorId: "err-skill",
      notes: "   ",
    }),
    /notes must not be blank/,
  );
  await assert.rejects(
    h.call("errors.update", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      errorId: "missing-error",
      resolved: true,
    }),
    /unknown error id/,
  );
});

test("advisory pivots accept into an adjacent node or dismiss without restructuring", async (t) => {
  const h = host(t);
  await createConversation(h);
  await savePath(h, makePath());

  const accepted = await h.call<{
    path: LearningPath;
    pivot: PathNode["pivotSuggestions"][number];
    insertedNode: PathNode | null;
    changed: boolean;
  }>("pivots.resolve", {
    pathId: "path-linear-algebra",
    nodeId: "n-skill",
    pivotId: "pivot-skill",
    action: "accept",
  });

  assert.equal(accepted.changed, true);
  assert.equal(accepted.pivot.status, "accepted");
  assert.ok(accepted.pivot.resolvedAt);
  assert.ok(accepted.insertedNode);
  assert.equal(accepted.pivot.insertedNodeId, accepted.insertedNode!.id);
  const inserted = accepted.insertedNode!;
  assert.equal(inserted.type, "skill");
  assert.equal(inserted.title, "Add a sign-tracking drill");
  assert.match(inserted.goal, /Close the gap behind "Node n-skill"/);
  assert.deepEqual(inserted.sourceAnchor, anchor(), "the repair inherits the anchor");
  assert.deepEqual(inserted.interleavesNodeIds, ["n-skill"]);
  assert.equal(inserted.progression, "unstarted");
  assert.deepEqual(inserted.childSessions, []);
  assert.deepEqual(inserted.errors, []);

  const structure = accepted.path.modules[0]!.nodes.map((node) => node.id);
  assert.deepEqual(structure, ["n-holistic", "n-concept", "n-skill", inserted.id]);
  assert.ok(
    accepted.path.modules[1]!.nodes.every((node) => node.id !== inserted.id),
    "the inserted node stays adjacent to its parent module",
  );

  // Repeating the same decision is idempotent and never inserts a second node.
  const repeated = await h.call<{ changed: boolean; insertedNode: PathNode | null }>(
    "pivots.resolve",
    { pathId: "path-linear-algebra", nodeId: "n-skill", pivotId: "pivot-skill", action: "accept" },
  );
  assert.equal(repeated.changed, false);
  assert.equal(repeated.insertedNode?.id, inserted.id);
  const afterRepeat = await h.call<{ path: LearningPath }>("paths.get", { id: "path-linear-algebra" });
  assert.equal(
    afterRepeat.path.modules[0]!.nodes.filter((node) => node.id === inserted.id).length,
    1,
  );

  // The opposite decision is refused, not silently applied.
  await assert.rejects(
    h.call("pivots.resolve", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      pivotId: "pivot-skill",
      action: "dismiss",
    }),
    /already accepted/,
  );

  // A separate pending pivot dismisses without inserting or reordering anything.
  const base = makePath();
  const withPending: LearningPath = {
    ...base,
    id: "path-dismiss",
    modules: base.modules.map((module) =>
      module.id === "module-structure"
        ? {
            ...module,
            nodes: module.nodes.map((node) =>
              node.id === "n-skill"
                ? {
                    ...node,
                    pivotSuggestions: [
                      {
                        id: "pivot-dismiss",
                        status: "pending",
                        proposalType: "contrast",
                        title: "Contrast two sign conventions",
                        rationale: "The learner keeps mapping the wrong convention.",
                        createdAt: AT,
                      },
                    ],
                  }
                : node,
            ),
          }
        : module,
    ),
  };
  await savePath(h, withPending);
  const before = await h.call<{ path: LearningPath }>("paths.get", { id: "path-dismiss" });
  const dismissed = await h.call<{
    path: LearningPath;
    pivot: PathNode["pivotSuggestions"][number];
    insertedNode: PathNode | null;
    changed: boolean;
  }>("pivots.resolve", {
    pathId: "path-dismiss",
    nodeId: "n-skill",
    pivotId: "pivot-dismiss",
    action: "dismiss",
  });
  assert.equal(dismissed.changed, true);
  assert.equal(dismissed.pivot.status, "dismissed");
  assert.ok(dismissed.pivot.resolvedAt);
  assert.equal(dismissed.pivot.insertedNodeId, undefined);
  assert.equal(dismissed.insertedNode, null);
  assert.deepEqual(
    dismissed.path.modules.map((module) => module.nodes.map((node) => node.id)),
    before.path.modules.map((module) => module.nodes.map((node) => node.id)),
    "dismiss leaves every module and node in place",
  );
  await assert.rejects(
    h.call("pivots.resolve", {
      pathId: "path-dismiss",
      nodeId: "n-skill",
      pivotId: "pivot-dismiss",
      action: "accept",
    }),
    /already dismissed/,
  );
  await assert.rejects(
    h.call("pivots.resolve", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      pivotId: "pivot-skill",
      action: "maybe",
    }),
    /action must be/,
  );
});

test("settings validate before writing, persist, and steer the Architect model", async (t) => {
  const directory = temporaryDirectory(t);
  const h = host(t, { dataDirectory: directory });
  await createConversation(h);

  assert.deepEqual((await h.call<{ settings: unknown }>("settings.get")).settings, {
    artifactDefaults: {},
  });

  const saved = await h.call<{ settings: any }>("settings.save", {
    artifactDefaults: { concept: "derivation_trace", contrast: "relational_map" },
    architect: { followHostSlot: true },
  });
  assert.equal(saved.settings.artifactDefaults.concept, "derivation_trace");
  assert.equal(saved.settings.artifactDefaults.contrast, "relational_map");
  assert.deepEqual(saved.settings.architect, { followHostSlot: true });
  assert.ok(h.events.some((event) => event.topic === "settings-changed"));
  // Persisted, not just in memory.
  assert.deepEqual(openLearningPathStore(directory).settings(), saved.settings);

  const beforeBytes = fs.readFileSync(path.join(directory, "settings.json"), "utf8");
  await assert.rejects(
    h.call("settings.save", { artifactDefaults: { lecture: "micro_code" } }),
    /unknown node type/,
  );
  await assert.rejects(
    h.call("settings.save", { artifactDefaults: { concept: "video" } }),
    /must be one of/,
  );
  await assert.rejects(
    h.call("settings.save", { artifactDefaults: {}, architect: { followHostSlot: false } }),
    /model.*required/,
  );
  await assert.rejects(
    h.call("settings.save", {
      artifactDefaults: {},
      architect: { followHostSlot: false, model: { provider: "missing", id: "nope" } },
    }),
    /not available/,
  );
  await assert.rejects(
    h.call("settings.save", {
      artifactDefaults: {},
      architect: {
        followHostSlot: false,
        model: { provider: "test", id: "other-model" },
        thinkingLevel: "high",
      },
    }),
    /does not support thinking level/,
  );
  assert.equal(
    fs.readFileSync(path.join(directory, "settings.json"), "utf8"),
    beforeBytes,
    "a rejected save leaves the previous bytes untouched",
  );

  const override = await h.call<{ settings: any }>("settings.save", {
    artifactDefaults: {},
    architect: {
      followHostSlot: false,
      model: { provider: "test", id: "other-model" },
      thinkingLevel: "off",
    },
  });
  assert.equal(override.settings.architect.followHostSlot, false);
  assert.equal(h.definitions.get("path-architect")?.model.id, "other-model");
  assert.equal(h.definitions.get("path-architect")?.model.thinkingLevel, "off");

  // A new Architect conversation uses the explicit override.
  await h.call("architect.create");
  assert.equal(h.definitions.get("path-architect")?.model.id, "other-model");

  // Following the host slot again resolves the catalog default on the next create.
  await h.call("settings.save", { artifactDefaults: {}, architect: { followHostSlot: true } });
  await h.call("architect.create");
  assert.equal(h.definitions.get("path-architect")?.model.id, "architect-model");
  assert.equal(h.definitions.get("path-architect")?.model.thinkingLevel, "medium");
});

test("path deletion removes only plugin records and orphaned uploads", async (t) => {
  const directory = temporaryDirectory(t);
  const chat: ChatRecord = {
    id: "chat-keep",
    title: "Kept native chat",
    createdAt: AT,
    updatedAt: AT,
    messages: [],
    kind: "teach",
  };
  const h = host(t, { dataDirectory: directory, chats: [chat] });
  await createConversation(h);

  const savedSource = await h.call<{
    reference: { sourceId: string; name: string; uploadedAt: string; byteSize?: number; sha256?: string };
  }>("sources.save", { name: "sigma-algebra.md", markdown: "# Sigma algebra\n\nA source." });
  const source = savedSource.reference;
  const sourceFile = path.join(directory, SOURCES_DIRECTORY, `${source.sourceId}.md`);
  assert.ok(fs.existsSync(sourceFile));

  const first = uploadedPath("path-shared-a", source);
  const second = uploadedPath("path-shared-b", source);
  await savePath(h, first);
  await savePath(h, second);

  const firstDelete = await h.call<{
    deleted: boolean;
    removedSources: string[];
    retainedSources: string[];
    preservedChats: number;
    knowledgeGraphRecordsChanged: number;
  }>("paths.delete", { pathId: "path-shared-a" });
  assert.equal(firstDelete.deleted, true);
  assert.deepEqual(firstDelete.removedSources, [], "the source is still used by the other path");
  assert.deepEqual(firstDelete.retainedSources, [source.sourceId]);
  assert.equal(firstDelete.preservedChats, 1);
  assert.equal(firstDelete.knowledgeGraphRecordsChanged, 0);
  assert.ok(fs.existsSync(sourceFile));
  assert.equal(h.chats.has("chat-keep"), true, "the native chat is untouched");
  assert.equal((await h.call<{ path: unknown }>("paths.get", { id: "path-shared-a" })).path, null);
  assert.ok(openLearningPathStore(directory).path("path-shared-b"));

  const secondDelete = await h.call<{
    deleted: boolean;
    removedSources: string[];
    retainedSources: string[];
    preservedChats: number;
  }>("paths.delete", { pathId: "path-shared-b" });
  assert.equal(secondDelete.deleted, true);
  assert.deepEqual(secondDelete.removedSources, [source.sourceId]);
  assert.deepEqual(secondDelete.retainedSources, []);
  assert.equal(secondDelete.preservedChats, 1);
  assert.equal(fs.existsSync(sourceFile), false, "the now-orphaned converted upload is removed");
  assert.deepEqual(openLearningPathStore(directory).sources(), []);
  assert.equal(h.chats.has("chat-keep"), true);

  const again = await h.call<{ deleted: boolean; removedSources: string[] }>("paths.delete", {
    pathId: "path-shared-b",
  });
  assert.equal(again.deleted, false, "deletion is retry-safe");
  assert.deepEqual(again.removedSources, []);

  await assert.rejects(h.call("paths.delete", { pathId: 42 }), /pathId must be a string/);
});
