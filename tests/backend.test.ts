/** Backend integration tests.
 *
 * These exercise the real `activate` function against an in-process host:
 * Architect definition lifecycle, uploaded-source chunk reading, validated
 * `save_learning_path`, request-ID retry safety and cancellation on activation
 * abort. No model request is made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ARCHITECT_DEFINITION_ID,
  DEFAULT_SOURCE_CHUNK_CHARS,
  MAX_SOURCE_CHUNK_CHARS,
} from "../src/architect-agent.ts";
import { ARCHITECT_FILE, SOURCES_DIRECTORY } from "../src/store.ts";
import { AT, makePath, rawPath } from "./fixtures.ts";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { PluginAgentTool } from "learnharness-plugin-api";
import { createHost } from "./host.ts";
import type { TestHost } from "./host.ts";

interface ToolResult {
  content: { type: string; text: string }[];
  details: any;
  isError?: boolean;
}

function temporaryDirectory(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-backend-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function host(t: { after: (fn: () => void) => void }, directory?: string): TestHost {
  const created = createHost(directory ? { dataDirectory: directory } : {});
  t.after(() => created.close());
  return created;
}

async function createConversation(h: TestHost): Promise<string> {
  const result = await h.call<{ conversation: { id: string } }>("architect.create");
  return result.conversation.id;
}

async function saveSource(h: TestHost, name: string, markdown: string) {
  return h.call<{ reference: { sourceId: string; name: string; sha256?: string }; deduplicated: boolean }>(
    "sources.save",
    { name, markdown },
  );
}

test("Architect definition is reconstructed on activation and released on cleanup", async (t) => {
  const dir = temporaryDirectory(t);
  const first = host(t, dir);
  assert.deepEqual(first.registered, [], "no model is configured before the first conversation");

  const created = await first.call<{ conversation: { id: string; definitionId: string } }>(
    "architect.create",
  );
  assert.equal(created.conversation.definitionId, ARCHITECT_DEFINITION_ID);
  assert.deepEqual(first.registered, [ARCHITECT_DEFINITION_ID]);

  const definition = first.definitions.get(ARCHITECT_DEFINITION_ID);
  assert.ok(definition);
  assert.deepEqual(
    (definition.tools ?? []).map((tool) => tool.name),
    ["list_uploaded_sources", "read_uploaded_source_chunk", "get_learning_path", "save_learning_path", "save_learning_path_json"],
  );
  assert.match(definition.instructions, /Learning Path Architect/);
  assert.deepEqual(definition.model, {
    provider: "test",
    id: "architect-model",
    thinkingLevel: "medium",
  });
  // The explicit host default is persisted, so a restart can re-register it.
  assert.ok(fs.existsSync(path.join(dir, ARCHITECT_FILE)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ARCHITECT_FILE), "utf8")).model.id, "architect-model");

  await first.cleanup();
  assert.deepEqual(first.unregistered, [ARCHITECT_DEFINITION_ID]);
  assert.equal(first.handlers.size, 0);

  const second = host(t, dir);
  assert.deepEqual(second.registered, [ARCHITECT_DEFINITION_ID], "activation re-registers the saved definition");
  assert.equal(second.definitions.get(ARCHITECT_DEFINITION_ID)?.model.id, "architect-model");

  // A different explicit model re-registers the definition and becomes the saved one.
  await second.call("architect.create", { model: { provider: "test", id: "other-model" } });
  assert.deepEqual(second.registered, [ARCHITECT_DEFINITION_ID, ARCHITECT_DEFINITION_ID]);
  assert.deepEqual(second.unregistered, [ARCHITECT_DEFINITION_ID]);
  assert.equal(second.definitions.get(ARCHITECT_DEFINITION_ID)?.model.id, "other-model");

  await assert.rejects(
    second.call("architect.create", { model: { provider: "test", id: "other-model", thinkingLevel: "high" } }),
    /does not support thinking level/,
  );
  await assert.rejects(
    second.call("architect.create", { model: { provider: "missing", id: "model" } }),
    /not available/,
  );
});

test("saving converted sources is bounded, hash-deduplicated and announced", async (t) => {
  const h = host(t);
  const markdown = "# Category Theory\n\nA source fact.";
  const first = await saveSource(h, "category-notes.md", markdown);
  assert.equal(first.deduplicated, false);
  assert.match(first.reference.sourceId, /^[0-9a-f-]{36}$/);
  assert.equal(first.reference.name, "category-notes.md");
  assert.equal(
    fs.readFileSync(path.join(h.dataDirectory, SOURCES_DIRECTORY, `${first.reference.sourceId}.md`), "utf8"),
    markdown,
  );

  const retried = await saveSource(h, "renamed-copy.md", markdown);
  assert.equal(retried.deduplicated, true);
  assert.equal(retried.reference.sourceId, first.reference.sourceId);
  assert.equal(retried.reference.name, "category-notes.md");

  const different = await saveSource(h, "more-notes.md", "# Different\n\nOther content.");
  assert.equal(different.deduplicated, false);
  assert.notEqual(different.reference.sourceId, first.reference.sourceId);

  const listed = await h.call<{ sources: { sourceId: string }[] }>("sources.list");
  assert.equal(listed.sources.length, 2);
  const sourceEvents = h.events.filter((event) => event.topic === "sources-changed");
  assert.equal(sourceEvents.length, 3);
  assert.deepEqual(sourceEvents[1]?.data, {
    sourceId: first.reference.sourceId,
    deduplicated: true,
  });

  await assert.rejects(h.call("sources.save", { name: "", markdown }), /name must not be blank/);
  await assert.rejects(h.call("sources.save", { name: "x.md", markdown: "   " }), /non-empty/);
  await assert.rejects(h.call("sources.save", { name: "x.md", markdown: 42 }), /markdown must be a string/);
});

test("read_uploaded_source_chunk streams bounded windows and never the whole book", async (t) => {
  const h = host(t);
  await createConversation(h);
  const markdown = Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n");
  const saved = await saveSource(h, "long-book.md", markdown);

  const listed = await h.runTool<ToolResult>("list_uploaded_sources", {});
  assert.equal(listed.isError, undefined);
  assert.deepEqual(listed.details.sources, [
    {
      sourceId: saved.reference.sourceId,
      name: "long-book.md",
      byteSize: Buffer.byteLength(markdown, "utf8"),
      uploadedAt: listed.details.sources[0].uploadedAt,
      sha256: saved.reference.sha256,
    },
  ]);

  const firstChunk = await h.runTool<ToolResult>("read_uploaded_source_chunk", {
    sourceId: saved.reference.sourceId,
  });
  assert.equal(firstChunk.isError, undefined);
  assert.equal(firstChunk.details.chunkStart, 0);
  assert.equal(firstChunk.details.chunkEnd, DEFAULT_SOURCE_CHUNK_CHARS);
  assert.equal(firstChunk.details.totalCharacters, markdown.length);
  assert.equal(firstChunk.details.nextOffset, DEFAULT_SOURCE_CHUNK_CHARS);
  assert.equal(firstChunk.details.text, markdown.slice(0, DEFAULT_SOURCE_CHUNK_CHARS));

  const rest = await h.runTool<ToolResult>("read_uploaded_source_chunk", {
    sourceId: saved.reference.sourceId,
    offset: firstChunk.details.nextOffset,
    limit: MAX_SOURCE_CHUNK_CHARS,
  });
  assert.equal(rest.details.chunkStart, DEFAULT_SOURCE_CHUNK_CHARS);
  assert.equal(rest.details.chunkEnd, Math.min(DEFAULT_SOURCE_CHUNK_CHARS + MAX_SOURCE_CHUNK_CHARS, markdown.length));
  assert.equal(rest.details.nextOffset, null, "a short corpus finishes inside the second window");

  const pastEnd = await h.runTool<ToolResult>("read_uploaded_source_chunk", {
    sourceId: saved.reference.sourceId,
    offset: markdown.length + 100,
    limit: 10,
  });
  assert.equal(pastEnd.details.text, "");
  assert.equal(pastEnd.details.nextOffset, null);
  assert.equal(pastEnd.details.chunkStart, markdown.length);

  const unknown = await h.runTool<ToolResult>("read_uploaded_source_chunk", {
    sourceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  });
  assert.equal(unknown.isError, true);
  assert.match(unknown.details.error, /Unknown uploaded source/);

  const invalid = await h.runTool<ToolResult>("read_uploaded_source_chunk", { sourceId: "../outside" });
  assert.equal(invalid.isError, true);
  assert.match(invalid.details.error, /Invalid source ID/);

  const tooLarge = await h.runTool<ToolResult>("read_uploaded_source_chunk", {
    sourceId: saved.reference.sourceId,
    limit: MAX_SOURCE_CHUNK_CHARS + 1,
  });
  assert.equal(tooLarge.isError, true);
  assert.match(tooLarge.details.error, /limit must be an integer/);
});

test("save_learning_path validates, links the conversation and preserves identity on update", async (t) => {
  const h = host(t);
  const chatId = await createConversation(h);

  const created = await h.runTool<ToolResult>("save_learning_path", rawPath());
  assert.equal(created.isError, undefined);
  assert.deepEqual(created.details, {
    pathId: "path-linear-algebra",
    title: "Linear algebra from canon",
    created: true,
    modules: 2,
    nodes: 6,
    updatedAt: created.details.updatedAt,
  });
  const stored = await h.call<{ path: any }>("paths.get", { id: "path-linear-algebra" });
  assert.equal(stored.path.architectChatId, chatId);
  assert.equal(stored.path.createdAt, AT, "a provided creation time survives");
  assert.equal(stored.path.updatedAt, created.details.updatedAt);
  assert.ok(h.events.some((event) => event.topic === "paths-changed"));

  const updatedInput = { ...rawPath(), title: "Retitled path", createdAt: "2026-02-02T00:00:00.000Z" };
  const updated = await h.runTool<ToolResult>("save_learning_path", updatedInput);
  assert.equal(updated.details.created, false);
  const after = await h.call<{ path: any }>("paths.get", { id: "path-linear-algebra" });
  assert.equal(after.path.title, "Retitled path");
  assert.equal(after.path.createdAt, AT, "updates keep the original creation time");
  assert.equal(after.path.updatedAt, updated.details.updatedAt);
  assert.equal((await h.call<{ paths: unknown[] }>("paths.list")).paths.length, 1);

  const invalid = { ...rawPath(), id: "Bad Id" };
  const rejected = await h.runTool<ToolResult>("save_learning_path", invalid);
  assert.equal(rejected.isError, true);
  assert.match(rejected.details.error, /Learning path rejected/);
  assert.match(rejected.details.error, /path\.id/);
  assert.equal((await h.call<{ paths: unknown[] }>("paths.list")).paths.length, 1);

  const ghostSource = {
    ...rawPath(),
    id: "path-ghost",
    sourceSpine: {
      mode: "uploaded",
      sources: [
        {
          sourceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
          name: "ghost.md",
          uploadedAt: AT,
        },
      ],
    },
  };
  const ghost = await h.runTool<ToolResult>("save_learning_path", ghostSource);
  assert.equal(ghost.isError, true);
  assert.match(ghost.details.error, /not stored/);

  const savedSource = await saveSource(h, "real.md", "# Real source");
  const uploadedPath = {
    ...ghostSource,
    id: "path-uploaded",
    sourceSpine: { mode: "uploaded", sources: [savedSource.reference] },
  };
  const uploaded = await h.runTool<ToolResult>("save_learning_path", uploadedPath);
  assert.equal(uploaded.isError, undefined);
  assert.equal(uploaded.details.created, true);
});

test("a minimal Architect draft becomes a complete validated path without mechanical fields", async (t) => {
  const h = host(t);
  const chatId = await createConversation(h);
  const definition = h.definitions.get(ARCHITECT_DEFINITION_ID)!;
  const schema = definition.tools?.find(tool => tool.name === "save_learning_path")?.parameters as {
    properties: Record<string, { type?: string; properties?: Record<string, unknown> }>;
    required: string[];
  };
  assert.deepEqual(schema.required, ["title", "goal", "sourceSpine", "modules"]);
  assert.ok(schema.properties.modules && schema.properties.sourceSpine);
  assert.equal(schema.properties.modules.type, "array", "the tool describes structured array arguments");

  const draft = {
    title: "Shader pseudo-randomness", goal: "Compose pseudo-random shader effects",
    sourceSpine: { mode: "canonical", references: [{ title: "The Book of Shaders", kind: "textbook" }] },
    modules: [{ title: "Randomness", nodes: [
      { type: "holistic", title: "The map", goal: "Connect hashes, noise and effects",
        sourceAnchor: { reference: "The Book of Shaders", chapter: "Random" } },
      { type: "concept", title: "Hashing", goal: "Explain deterministic pseudo-random values",
        sourceAnchor: { reference: "The Book of Shaders", chapter: "Random" } },
    ] }],
  };
  const saved = await h.runTool<ToolResult>("save_learning_path", draft);
  assert.equal(saved.isError, undefined);
  const path = (await h.call<{ path: any }>("paths.get", { id: saved.details.pathId })).path;
  assert.equal(path.architectChatId, chatId);
  assert.match(path.id, /^[0-9a-f-]{36}$/);
  assert.ok(path.createdAt && path.updatedAt);
  assert.match(path.modules[0].id, /^[0-9a-f-]{36}$/);
  assert.match(path.modules[0].nodes[0].id, /^[0-9a-f-]{36}$/);
  assert.equal(path.modules[0].nodes[0].progression, "unstarted");
  assert.deepEqual(path.modules[0].nodes[0].childSessions, []);
  assert.deepEqual(path.modules[0].nodes[0].errors, []);
  assert.deepEqual(path.modules[0].nodes[0].pivotSuggestions, []);
  assert.deepEqual(path.modules[0].nodes[1].interleavesNodeIds, [path.modules[0].nodes[0].id]);

  const updated = await h.runTool<ToolResult>("save_learning_path", {
    id: path.id, title: "Retitled shaders", goal: draft.goal, sourceSpine: draft.sourceSpine,
    modules: [{ id: path.modules[0].id, title: "Randomness", nodes: path.modules[0].nodes.map(
      (node: any) => ({ id: node.id, type: node.type, title: node.title, goal: node.goal, sourceAnchor: node.sourceAnchor }),
    ) }],
  });
  assert.equal(updated.isError, undefined);
  const after = (await h.call<{ path: any }>("paths.get", { id: path.id })).path;
  assert.equal(after.createdAt, path.createdAt);
  assert.deepEqual(after.modules[0].nodes[1].interleavesNodeIds, [path.modules[0].nodes[0].id]);
  const truncated = await h.runTool<ToolResult>("save_learning_path", {
    id: path.id, title: "Accidental truncation", goal: draft.goal, sourceSpine: draft.sourceSpine,
    modules: [{ id: path.modules[0].id, title: "Randomness", nodes: [{
      id: path.modules[0].nodes[0].id, type: "holistic", title: "The map",
      goal: "Connect hashes, noise and effects", sourceAnchor: path.modules[0].nodes[0].sourceAnchor,
    }] }],
  });
  assert.equal(truncated.isError, true);
  assert.match(truncated.details.error, /every existing module and node id/);
  assert.equal((await h.call<{ path: any }>("paths.get", { id: path.id })).path.title, "Retitled shaders");

  const invalid = await h.runTool<ToolResult>("save_learning_path", {
    ...draft, modules: [{ title: "Bad", nodes: [{ type: "concept", title: "Bad", goal: "Explain hashing",
      sourceAnchor: "The Book of Shaders, Random" }] }],
  });
  assert.equal(invalid.isError, true);
  assert.match(invalid.details.error, /sourceAnchor/);
  assert.equal((await h.call<{ paths: unknown[] }>("paths.list")).paths.length, 1);

  const asJson = await h.runTool<ToolResult>("save_learning_path_json", {
    draftJson: JSON.stringify({ ...draft, title: "Another shader path" }),
  });
  assert.equal(asJson.isError, undefined);
  assert.notEqual(asJson.details.pathId, path.id);
  const coerced = await h.runTool<ToolResult>("save_learning_path", {
    ...draft, title: "String-encoded modules", modules: JSON.stringify(draft.modules),
  });
  assert.equal(coerced.isError, undefined, "string-encoded modules are healed, not rejected");
  const malformed = await h.runTool<ToolResult>("save_learning_path_json", {
    draftJson: '<parameter name="modules">[invalid]</parameter>',
  });
  assert.equal(malformed.isError, true);
  assert.match(malformed.details.error, /valid JSON object/);
  assert.equal((await h.call<{ paths: unknown[] }>("paths.list")).paths.length, 3);
});

test("weak-model argument shapes pass real tool validation after prepareArguments", async (t) => {
  const h = host(t);
  await createConversation(h);
  const tool = h.tool("save_learning_path") as PluginAgentTool & { prepareArguments: (args: unknown) => unknown };
  assert.equal(typeof tool.prepareArguments, "function");
  const draft = {
    title: "Shaders", goal: "Compose shader effects",
    sourceSpine: { mode: "canonical", references: [{ title: "The Book of Shaders", kind: "textbook" }] },
    modules: [{ title: "Randomness", nodes: [{ type: "concept", title: "Hashing", goal: "Explain hashes",
      sourceAnchor: { reference: "The Book of Shaders" } }] }],
  };
  assert.equal(tool.prepareArguments(draft), draft, "well-formed arguments pass through untouched");
  const validate = (args: unknown) => validateToolArguments(
    tool as never,
    { type: "toolCall", id: "call-1", name: tool.name, arguments: tool.prepareArguments(args) } as never,
  );
  assert.throws(() => validateToolArguments(tool as never, {
    type: "toolCall", id: "call-1", name: tool.name, arguments: { ...draft, modules: JSON.stringify(draft.modules) },
  } as never), /Validation failed/, "without healing, a string-encoded array never reaches execute");
  const healed = validate({ ...draft, modules: JSON.stringify(draft.modules), sourceSpine: JSON.stringify(draft.sourceSpine) });
  assert.deepEqual(healed, draft);
  assert.deepEqual(validate({ path: draft }), draft, "a single { path } wrapper is unwrapped");
});

test("refinement reads ids back, preserves learner state and path preferences", async (t) => {
  const h = host(t);
  await createConversation(h);
  const draft = {
    title: "Shaders", goal: "Compose shader effects", artifactDefault: "relational_map",
    sourceSpine: { mode: "canonical", references: [{ title: "The Book of Shaders", kind: "textbook" }] },
    modules: [{ title: "Randomness", nodes: [
      { type: "holistic", title: "The map", goal: "Connect ideas", sourceAnchor: { reference: "The Book of Shaders" } },
      { type: "concept", title: "Hashing", goal: "Explain hashes", sourceAnchor: { reference: "The Book of Shaders" } },
    ] }],
  };
  const saved = await h.runTool<ToolResult>("save_learning_path", draft);
  assert.equal(saved.isError, undefined);
  const stored = (await h.call<{ path: any }>("paths.get", { id: saved.details.pathId })).path;
  const [first, second] = stored.modules[0].nodes;
  const savedText = saved.content[0]!.text;
  assert.ok(savedText.includes(stored.modules[0].id), "the save result names generated module ids");
  assert.ok(savedText.includes(first.id) && savedText.includes(second.id));

  const outline = await h.runTool<ToolResult>("get_learning_path", {});
  assert.equal(outline.isError, undefined);
  assert.equal(outline.details.path.id, stored.id, "without an id, the conversation's own path is returned");
  assert.deepEqual(outline.details.path.modules[0].nodes.map((node: any) => node.id), [first.id, second.id]);
  assert.equal(outline.details.path.modules[0].nodes[0].childSessions, undefined, "learner records stay out of the outline");
  const unknown = await h.runTool<ToolResult>("get_learning_path", { id: "path-missing" });
  assert.equal(unknown.isError, true);

  await h.call("paths.updateNode", { pathId: stored.id, nodeId: first.id, progression: "consolidated" });

  // The model echoes a stale snapshot of node state and omits the path-level preference.
  const refined = await h.runTool<ToolResult>("save_learning_path", {
    id: stored.id, title: "Shaders, refined", goal: draft.goal, sourceSpine: draft.sourceSpine,
    modules: [{ id: stored.modules[0].id, title: "Randomness", nodes: [
      { id: first.id, type: "holistic", title: "The map", goal: "Connect ideas",
        sourceAnchor: { reference: "The Book of Shaders" }, progression: "unstarted", errors: [] },
      { id: second.id, type: "concept", title: "Hashing", goal: "Explain hashes",
        sourceAnchor: { reference: "The Book of Shaders" } },
      { type: "skill", title: "Value noise", goal: "Build value noise", sourceAnchor: { reference: "The Book of Shaders" } },
    ] }],
  });
  assert.equal(refined.isError, undefined, refined.details?.error);
  const after = (await h.call<{ path: any }>("paths.get", { id: stored.id })).path;
  assert.equal(after.title, "Shaders, refined");
  assert.equal(after.artifactDefault, "relational_map", "an omitted path preference survives refinement");
  assert.equal(after.modules[0].nodes[0].progression, "consolidated", "stale model state never overwrites progress");
  assert.equal(after.modules[0].nodes[2].progression, "unstarted");
  assert.deepEqual(after.modules[0].nodes[2].interleavesNodeIds, [first.id, second.id]);

  const truncated = await h.runTool<ToolResult>("save_learning_path", {
    id: stored.id, title: "Truncated", goal: draft.goal, sourceSpine: draft.sourceSpine,
    modules: [{ id: stored.modules[0].id, title: "Randomness", nodes: [
      { id: first.id, type: "holistic", title: "The map", goal: "Connect ideas", sourceAnchor: { reference: "The Book of Shaders" } },
    ] }],
  });
  assert.equal(truncated.isError, true);
  assert.ok(truncated.details.error.includes(second.id), "the rejection names the missing node id");
  assert.match(truncated.details.error, /get_learning_path/);
});

test("switching the shared Architect model is refused while a conversation is running", async (t) => {
  const h = host(t);
  const chatId = await createConversation(h);
  await h.call("architect.send", { id: chatId, text: "Design a path", requestId: "req-run" });
  await assert.rejects(
    h.call("architect.create", { model: { provider: "test", id: "other-model" } }),
    /still running/,
  );
  assert.deepEqual(h.unregistered, [], "the running conversation was not cancelled");
  assert.equal(h.definitions.get(ARCHITECT_DEFINITION_ID)?.model.id, "architect-model");
  // The same model needs no re-registration, so a new conversation can start.
  await h.call("architect.create");
  await h.call("architect.abort", { id: chatId });
  await h.call("architect.create", { model: { provider: "test", id: "other-model" } });
  assert.equal(h.definitions.get(ARCHITECT_DEFINITION_ID)?.model.id, "other-model");
});

test("a settings model change waits for the running Architect conversation instead of cancelling it", async (t) => {
  const h = host(t);
  const chatId = await createConversation(h);
  await h.call("architect.send", { id: chatId, text: "Design a path", requestId: "req-run" });
  const override = {
    artifactDefaults: {},
    architect: { followHostSlot: false, model: { provider: "test", id: "other-model" } },
  };

  const saved = await h.call<{ settings: any; modelPending: boolean }>("settings.save", override);
  assert.equal(saved.modelPending, true);
  assert.equal(saved.settings.architect.model.id, "other-model", "the preference is saved immediately");
  assert.deepEqual(h.unregistered, [], "the running conversation was not cancelled");
  assert.equal(h.records.get(chatId)?.status, "running");
  assert.equal(h.definitions.get(ARCHITECT_DEFINITION_ID)?.model.id, "architect-model");

  // When the run ends, the pending model is applied.
  await h.call("architect.abort", { id: chatId });
  assert.equal(h.definitions.get(ARCHITECT_DEFINITION_ID)?.model.id, "other-model");
  assert.deepEqual(h.unregistered, [ARCHITECT_DEFINITION_ID]);

  // Saving unrelated settings with the same model does not re-register.
  const again = await h.call<{ modelPending: boolean }>("settings.save", override);
  assert.equal(again.modelPending, false);
  assert.deepEqual(h.unregistered, [ARCHITECT_DEFINITION_ID]);
});

test("architect.progress returns live state without the committed history", async (t) => {
  const h = host(t);
  const chatId = await createConversation(h);
  await h.call("architect.send", { id: chatId, text: "Design a path", requestId: "req-progress" });
  const { progress } = await h.call<{ progress: Record<string, unknown> }>("architect.progress", { id: chatId });
  assert.equal(progress.id, chatId);
  assert.equal(progress.status, "running");
  assert.equal(progress.messageCount, 1);
  assert.deepEqual(progress.pending, []);
  assert.ok(!("messages" in progress), "history is not resent");
  await assert.rejects(h.call("architect.progress", { id: "missing" }), /Unknown conversation/);
});

test("save_learning_path refuses to run without an active conversation", async (t) => {
  const dir = temporaryDirectory(t);
  const first = host(t, dir);
  await createConversation(first);
  await first.cleanup();
  first.close();

  // Reconstructed definition, but no conversation has been opened in this activation.
  const second = host(t, dir);
  const result = await second.runTool<ToolResult>("save_learning_path", rawPath());
  assert.equal(result.isError, true);
  assert.match(result.details.error, /No active Architect conversation/);
  assert.equal(second.ctx.signal.aborted, false);
});

test("request IDs make create and send retries safe and abort is idempotent", async (t) => {
  const h = host(t);
  const firstCreate = await h.call<{ conversation: { id: string }; deduplicated: boolean }>(
    "architect.create",
    { requestId: "create-1" },
  );
  const retriedCreate = await h.call<{ conversation: { id: string }; deduplicated: boolean }>(
    "architect.create",
    { requestId: "create-1" },
  );
  assert.equal(retriedCreate.conversation.id, firstCreate.conversation.id);
  assert.equal(retriedCreate.deduplicated, true);
  assert.equal(h.records.size, 1, "a retried create does not open a second conversation");

  const chatId = firstCreate.conversation.id;
  const sent = await h.call<{ conversation: { messages: unknown[]; status: string } }>("architect.send", {
    id: chatId,
    text: "Design a path for linear algebra.",
    requestId: "send-1",
  });
  assert.equal(sent.conversation.messages.length, 1);
  assert.equal(sent.conversation.status, "running");

  const retriedSend = await h.call<{ conversation: { messages: unknown[] } }>("architect.send", {
    id: chatId,
    text: "Design a path for linear algebra.",
    requestId: "send-1",
  });
  assert.equal(retriedSend.conversation.messages.length, 1, "the accepted request ID is not submitted twice");

  await assert.rejects(
    h.call("architect.send", { id: chatId, text: "Concurrent message", requestId: "send-2" }),
    /busy/,
  );
  await assert.rejects(
    h.call("architect.send", { id: chatId, text: "No retry key" }),
    /requestId must be a string/,
  );

  await h.call("architect.abort", { id: chatId });
  assert.equal(h.records.get(chatId)?.status, "interrupted");
  await h.call("architect.abort", { id: chatId });
  assert.deepEqual(h.abortedCalls, [chatId, chatId], "aborting an idle run is harmless");

  const next = await h.call<{ conversation: { messages: unknown[]; status: string } }>("architect.send", {
    id: chatId,
    text: "Continue after the interruption.",
    requestId: "send-3",
  });
  assert.equal(next.conversation.messages.length, 2);
  assert.equal(next.conversation.status, "running");
  assert.ok(h.events.some((event) => event.topic === "architect-changed" && (event.data as any).kind === "created"));
  assert.ok(h.events.some((event) => event.topic === "architect-changed" && (event.data as any).kind === "aborted"));
});

test("activation abort cancels Architect runs and fences later writes", async (t) => {
  const h = host(t);
  const chatId = await createConversation(h);
  await h.call("architect.send", { id: chatId, text: "Start designing.", requestId: "send-1" });
  assert.equal(h.records.get(chatId)?.status, "running");
  const eventsBefore = h.events.length;

  h.controller.abort();
  assert.ok(h.abortedCalls.includes(chatId), "activation abort cancels the running Architect conversation");
  assert.equal(h.records.get(chatId)?.status, "interrupted");
  assert.equal(h.events.length, eventsBefore, "no live notification is emitted after cancellation");

  await assert.rejects(h.call("architect.send", { id: chatId, text: "Later", requestId: "send-2" }), /shutting down/);
  await assert.rejects(h.call("sources.save", { name: "x.md", markdown: "# X" }), /shutting down/);
  await assert.rejects(h.runTool("save_learning_path", rawPath()), /shutting down/);
  assert.equal(fs.existsSync(path.join(h.dataDirectory, "learning-paths.json")), false);
  assert.equal(fs.existsSync(path.join(h.dataDirectory, "paths")), false);

  await h.cleanup();
  assert.equal(h.handlers.size, 0);
  assert.deepEqual(h.unregistered, [ARCHITECT_DEFINITION_ID]);
});

test("paths.list summarizes stored paths without loading tool state", async (t) => {
  const h = host(t);
  await createConversation(h);
  await h.runTool("save_learning_path", { ...makePath(), architectChatId: null });
  const result = await h.call<{ paths: any[] }>("paths.list");
  assert.deepEqual(result.paths, [
    {
      id: "path-linear-algebra",
      title: "Linear algebra from canon",
      goal: "Build durable linear-algebra understanding.",
      updatedAt: result.paths[0].updatedAt,
      moduleCount: 2,
      nodeCount: 6,
      sourceMode: "canonical",
      sourceTitles: ["OSTEP"],
      nodeStates: { unstarted: 3, in_progress: 2, consolidated: 1 },
      pendingPivotCount: 1,
      unresolvedErrorCount: 1,
      tags: [],
      folder: null,
      architectChatId: "conversation-1",
    },
  ]);
});

test("paths.updateNode records progression and per-node artifacts without rewriting identity", async (t) => {
  const h = host(t);
  await createConversation(h);
  await h.runTool("save_learning_path", rawPath());

  const progressed = await h.call<{ path: any }>("paths.updateNode", {
    pathId: "path-linear-algebra",
    nodeId: "n-concept",
    progression: "consolidated",
  });
  assert.equal(progressed.path.createdAt, AT, "editing a node keeps the path creation time");
  assert.equal(progressed.path.architectChatId, "conversation-1");
  const concept = progressed.path.modules[0].nodes[1];
  assert.equal(concept.progression, "consolidated");
  assert.equal(concept.artifactConfig.type, "micro_code", "an absent field is untouched");
  assert.ok(h.events.some((event) => event.topic === "paths-changed" && (event.data as any).nodeId === "n-concept"));

  const preserved = await h.call<{ path: any }>("paths.updateNode", {
    pathId: "path-linear-algebra",
    nodeId: "n-concept",
    artifactType: "micro_code",
  });
  assert.deepEqual(preserved.path.modules[0].nodes[1].artifactConfig, {
    type: "micro_code",
    instructions: "Write the smallest failing interpreter.",
  }, "choosing the current artifact keeps its instructions");

  const artifact = await h.call<{ path: any }>("paths.updateNode", {
    pathId: "path-linear-algebra",
    nodeId: "n-concept",
    artifactType: "relational_map",
  });
  assert.deepEqual(artifact.path.modules[0].nodes[1].artifactConfig, { type: "relational_map" });

  const cleared = await h.call<{ path: any }>("paths.updateNode", {
    pathId: "path-linear-algebra",
    nodeId: "n-concept",
    artifactType: null,
  });
  assert.equal(cleared.path.modules[0].nodes[1].artifactConfig, null, "null restores the path default");

  await assert.rejects(h.call("paths.updateNode", { pathId: "path-linear-algebra", nodeId: "n-concept" }), /needs progression or artifactType/);
  await assert.rejects(
    h.call("paths.updateNode", { pathId: "path-linear-algebra", nodeId: "n-concept", progression: "primed" }),
    /progression must be one of/,
  );
  await assert.rejects(
    h.call("paths.updateNode", { pathId: "path-linear-algebra", nodeId: "n-concept", artifactType: "essay" }),
    /artifactType must be null or one of/,
  );
  await assert.rejects(
    h.call("paths.updateNode", { pathId: "path-linear-algebra", nodeId: "n-missing", progression: "in_progress" }),
    /Unknown node/,
  );
  await assert.rejects(
    h.call("paths.updateNode", { pathId: "path-missing", nodeId: "n-concept", progression: "in_progress" }),
    /Unknown path/,
  );
});

test("paths.updateMeta stores learner grouping tags without touching the curriculum", async (t) => {
  const h = host(t);
  await createConversation(h);
  await h.runTool("save_learning_path", rawPath());

  const tagged = await h.call<{ path: any }>("paths.updateMeta", {
    pathId: "path-linear-algebra",
    tags: ["exam:step-2", "field:systems"],
  });
  assert.deepEqual(tagged.path.tags, ["exam:step-2", "field:systems"]);
  assert.equal(tagged.path.architectChatId, "conversation-1");
  assert.equal(tagged.path.createdAt, AT, "filing a path does not rewrite its identity");
  assert.deepEqual(
    tagged.path.modules[0].nodes[1].childSessions[0].chatId,
    "chat-1",
    "the curriculum is untouched by metadata",
  );
  assert.ok(
    h.events.some((event) => event.topic === "paths-changed" && (event.data as any).id === "path-linear-algebra"),
  );

  const listed = await h.call<{ paths: any[] }>("paths.list");
  assert.deepEqual(listed.paths[0].tags, ["exam:step-2", "field:systems"]);

  const cleared = await h.call<{ path: any }>("paths.updateMeta", {
    pathId: "path-linear-algebra",
    tags: [],
  });
  assert.equal(cleared.path.tags, undefined, "clearing tags drops the key entirely");

  const reloaded = await h.call<{ path: any }>("paths.get", { id: "path-linear-algebra" });
  assert.equal(reloaded.path.tags, undefined, "the store round-trips the cleared record");

  await assert.rejects(h.call("paths.updateMeta", { pathId: "path-linear-algebra", tags: "exam" }), /tags must be an array/);
  await assert.rejects(h.call("paths.updateMeta", { pathId: "path-linear-algebra", tags: [""] }), /must be at least 1 character/);
  await assert.rejects(
    h.call("paths.updateMeta", { pathId: "path-linear-algebra", tags: ["x".repeat(41)] }),
    /must be at most 40 characters/,
  );
  await assert.rejects(
    h.call("paths.updateMeta", { pathId: "path-linear-algebra", tags: ["field:systems", "Field:Systems"] }),
    /duplicate tag/,
  );
  await assert.rejects(
    h.call("paths.updateMeta", { pathId: "path-linear-algebra", tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i"] }),
    /at most 8 entries/,
  );
  await assert.rejects(h.call("paths.updateMeta", { pathId: "path-missing", tags: [] }), /Unknown path/);
});

test("paths.updateMeta files a path into one folder hierarchy and clears it on empty", async (t) => {
  const h = host(t);
  await createConversation(h);
  await h.runTool("save_learning_path", rawPath());

  const filed = await h.call<{ path: any }>("paths.updateMeta", {
    pathId: "path-linear-algebra",
    tags: [],
    folder: "exam/step-2",
  });
  assert.equal(filed.path.folder, "exam/step-2");
  assert.equal(filed.path.createdAt, AT, "filing does not rewrite path identity");

  const listed = await h.call<{ paths: any[] }>("paths.list");
  assert.equal(listed.paths[0].folder, "exam/step-2", "the overview summary carries the folder");

  const retagged = await h.call<{ path: any }>("paths.updateMeta", {
    pathId: "path-linear-algebra",
    tags: ["field:systems"],
  });
  assert.equal(retagged.path.folder, "exam/step-2", "an omitted folder leaves the filing alone");

  const cleared = await h.call<{ path: any }>("paths.updateMeta", {
    pathId: "path-linear-algebra",
    tags: [],
    folder: "",
  });
  assert.equal(cleared.path.folder, undefined, "an empty folder drops the key entirely");
  const reloaded = await h.call<{ path: any }>("paths.get", { id: "path-linear-algebra" });
  assert.equal(reloaded.path.folder, undefined, "the store round-trips the cleared record");

  await h.call("paths.updateMeta", { pathId: "path-linear-algebra", tags: [], folder: "field/systems" });
  const nulled = await h.call<{ path: any }>("paths.updateMeta", {
    pathId: "path-linear-algebra",
    tags: [],
    folder: null,
  });
  assert.equal(nulled.path.folder, undefined, "null also clears, mirroring tags");

  await assert.rejects(
    h.call("paths.updateMeta", { pathId: "path-linear-algebra", tags: [], folder: 7 }),
    /folder must be a string or null/,
  );
  await assert.rejects(
    h.call("paths.updateMeta", { pathId: "path-linear-algebra", tags: [], folder: "exam/" }),
    /folder \(level 2\): must not be empty/,
  );
  await assert.rejects(
    h.call("paths.updateMeta", { pathId: "path-linear-algebra", tags: [], folder: "x".repeat(41) }),
    /folder \(level 1\): must be at most 40 characters/,
  );
  await assert.rejects(
    h.call("paths.updateMeta", {
      pathId: "path-linear-algebra",
      tags: [],
      folder: "a/b/c/d/e/f/g",
    }),
    /a folder has at most 6 levels/,
  );
  await assert.rejects(
    h.call("paths.updateMeta", { pathId: "path-missing", tags: [], folder: "exam/step-2" }),
    /Unknown path/,
  );
});

test("paths.export renders validated JSON and Markdown with download metadata", async (t) => {
  const h = host(t);
  await createConversation(h);
  await h.runTool("save_learning_path", rawPath());

  const json = await h.call<{
    pathId: string;
    title: string;
    format: string;
    filename: string;
    mimeType: string;
    content: string;
  }>("paths.export", { pathId: "path-linear-algebra", format: "json" });
  assert.equal(json.pathId, "path-linear-algebra");
  assert.equal(json.title, "Linear algebra from canon");
  assert.equal(json.format, "json");
  assert.equal(json.filename, "linear-algebra-from-canon.json");
  assert.equal(json.mimeType, "application/json");
  assert.equal(JSON.parse(json.content).id, "path-linear-algebra");
  assert.match(json.content, /"modules"/);

  const markdown = await h.call<typeof json>("paths.export", {
    id: "path-linear-algebra",
    format: "markdown",
  });
  assert.equal(markdown.format, "markdown");
  assert.equal(markdown.filename, "linear-algebra-from-canon.md");
  assert.equal(markdown.mimeType, "text/markdown");
  assert.match(markdown.content, /^# Linear algebra from canon/);
  assert.match(markdown.content, /- \*\*Progress:\*\* 1 of 6 nodes consolidated · 2 in progress/);
  assert.match(markdown.content, /#### Node n-concept/);
  assert.match(markdown.content, /Micro-code \/ implementation/);

  await assert.rejects(
    h.call("paths.export", { pathId: "path-missing", format: "json" }),
    /Unknown path: path-missing/,
  );
  await assert.rejects(
    h.call("paths.export", { pathId: "path-linear-algebra", format: "pdf" }),
    /format must be "json" or "markdown"/,
  );
  await assert.rejects(h.call("paths.export", { format: "json" }), /pathId must be a string/);
});

test("paths.export is fenced once activation aborts", async (t) => {
  const h = host(t);
  await createConversation(h);
  await h.runTool("save_learning_path", rawPath());
  h.controller.abort();
  await assert.rejects(
    h.call("paths.export", { pathId: "path-linear-algebra", format: "json" }),
    /shutting down/,
  );
  await h.cleanup();
});

test("get_learning_path lists node-linked workspace items by title, read through the chunk tool", async (t) => {
  const h = host(t);
  await createConversation(h);
  const savedPath = await h.runTool<ToolResult>("save_learning_path", rawPath());
  assert.equal(savedPath.isError, undefined, savedPath.details?.error);
  const pathId = savedPath.details.pathId;
  const stored = (await h.call<{ path: { modules: { nodes: { id: string; title: string }[] }[] } }>(
    "paths.get",
    { id: pathId },
  )).path;
  const nodeId = stored.modules[0]!.nodes[0]!.id;

  // A converted document filed mid-path: the manifest references the global
  // source; the Architect never receives content, only kind/title/sourceId.
  const filed = await h.call<{ item: { id: string; sourceId: string } }>("workspace.saveSource", {
    pathId,
    name: "paper.pdf",
    markdown: "# A paper\n\nNode-linked document text.",
    links: [{ to: nodeId, rel: "grounds" }],
  });
  await h.call("workspace.saveNote", {
    pathId,
    title: "Feynman notes",
    markdown: "Learner note text.",
    links: [{ to: nodeId, rel: "informs" }],
  });

  const outline = await h.runTool<ToolResult>("get_learning_path", { id: pathId });
  assert.equal(outline.isError, undefined, outline.details?.error);
  const items = outline.details.path.workspace.items;
  assert.deepEqual(items, [
    {
      kind: "source",
      title: "paper.pdf",
      sourceId: filed.item.sourceId,
      linkedTo: [nodeId],
    },
    {
      kind: "note",
      title: "Feynman notes",
      linkedTo: [nodeId],
    },
  ], "titles only: no content, no byteSize, no provenance in the outline");

  // Reading a filed document stays on the existing bounded chunk tool.
  const chunk = await h.runTool<ToolResult>("read_uploaded_source_chunk", {
    sourceId: filed.item.sourceId,
  });
  assert.equal(chunk.isError, undefined);
  assert.equal(chunk.details.text, "# A paper\n\nNode-linked document text.");
  assert.equal(chunk.details.nextOffset, null);
});
