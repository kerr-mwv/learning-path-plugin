/** Native child-session bridge tests.
 *
 * These run the real backend activation against the in-process host: native tool
 * instructions/factories, zero injection for unlinked or deleted chats, brief and
 * watchpoint delivery, and persistence of progress/error/pivot writes. No model
 * request is made; `ctx.learning` is the same read-only contract the app exposes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ChatRecord } from "learnharness-plugin-api";
import { openLearningPathStore } from "../src/store.ts";
import { ITEM_ID_2, ITEM_ID_3, ITEM_ID_4, makeItem, makePath, AT } from "./fixtures.ts";
import { createHost } from "./host.ts";
import type { TestHost } from "./host.ts";
import { NATIVE_BRIDGE_INSTRUCTIONS } from "../src/native-bridge.ts";
import { LEARNING_PATH_TOOL_NAMES } from "../src/tool-names.ts";

function chat(id: string, kind: "teach" | "practice" = "teach", title = id): ChatRecord {
  return {
    id,
    title,
    createdAt: AT,
    updatedAt: AT,
    messages: [],
    kind,
  };
}

function temporaryDirectory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-native-"));
}

/** Persist the path before activation so the backend store reads it on open. */
function hostWithPath(chats: readonly ChatRecord[]): { host: TestHost; directory: string } {
  const directory = temporaryDirectory();
  openLearningPathStore(directory).savePath(makePath());
  const host = createHost({ dataDirectory: directory, chats });
  return { host, directory };
}

function close(host: TestHost, directory: string): void {
  host.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

function toolByName(tools: readonly AgentTool[], name: string): AgentTool {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found, `Missing native tool ${name}`);
  return found;
}

async function runTool(
  tools: readonly AgentTool[],
  name: string,
  args: unknown,
): Promise<{ text: string; details: Record<string, unknown>; isError: boolean }> {
  const tool = toolByName(tools, name);
  assert.ok(typeof tool.execute === "function");
  const result = await tool.execute("tool-call-1", args as never, new AbortController().signal);
  const content = result.content as { type: string; text?: string }[];
  const text = content.find((part) => part.type === "text")?.text ?? "";
  return {
    text,
    details: (result.details ?? {}) as Record<string, unknown>,
    isError: result.isError === true,
  };
}

function savedPath(directory: string, pathId = "path-linear-algebra") {
  const found = openLearningPathStore(directory).path(pathId);
  assert.ok(found, "Saved path should exist");
  return found;
}

test("instructions exist, and native tools are injected only for linked chats of the matching kind", async () => {
  const { host, directory } = hostWithPath([
    chat("chat-1", "teach"),
    chat("chat-practice", "practice"),
    chat("chat-unlinked", "teach"),
  ]);
  try {
    assert.equal(host.instructions.length, 1);
    assert.deepEqual(host.instructions[0]!.agents, ["prober", "teacher", "practice"]);
    assert.match(host.instructions[0]!.text, /If learning_path_get_brief is not in your current tool set, ignore this entire section/);
    assert.equal(host.instructions[0]!.text, NATIVE_BRIDGE_INSTRUCTIONS);

    const linked = await host.call<{ path: { id: string } }>("sessions.link", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      chatId: "chat-practice",
      kind: "practice",
    });
    assert.equal(linked.path.id, "path-linear-algebra");

    const unlinked = host.nativeTools("chat-unlinked", "teacher");
    assert.deepEqual(unlinked, [], "an unlinked native chat receives zero plugin tools");

    const teaching = host.nativeTools("chat-1", "teacher");
    assert.deepEqual(
      teaching.map((tool) => tool.name),
      [...LEARNING_PATH_TOOL_NAMES],
    );
    assert.equal(host.nativeTools("chat-1", "prober").length, 6);
    assert.deepEqual(host.nativeTools("chat-1", "practice"), [], "teaching chats do not feed practice");

    const practice = host.nativeTools("chat-practice", "practice");
    assert.equal(practice.length, 6);
    assert.deepEqual(host.nativeTools("chat-practice", "teacher"), []);
  } finally {
    close(host, directory);
  }
});

test("map revisit guidance reaches only enabled relational-map teaching briefs and teacher instructions", async () => {
  const directory = temporaryDirectory();
  const path = { ...makePath(), artifactDefault: null };
  openLearningPathStore(directory).savePath(path);
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-map"), chat("chat-concept"), chat("practice", "practice")] });
  try {
    await host.call("settings.save", { artifactDefaults: {}, mapRevisitEnabled: true });
    await host.call("sessions.link", {
      pathId: path.id,
      nodeId: "n-contrast",
      chatId: "chat-map",
      kind: "teaching",
    });
    const teacher = host.nativeTools("chat-map", "teacher");
    const brief = await runTool(teacher, "learning_path_get_brief", {});
    assert.match(brief.text, /Optional earlier relational-map revisit/);
    assert.match(brief.text, /keep, change or connect/i);
    assert.match(brief.text, /If the learner does not have an earlier map|continue normally/i);
    assert.match(brief.text, /Never scrape transcripts, treat artifactNote as the full map/i);

    await host.call("sessions.link", {
      pathId: path.id,
      nodeId: "n-contrast",
      chatId: "practice",
      kind: "practice",
    });
    const practice = await runTool(host.nativeTools("practice", "practice"), "learning_path_get_brief", {});
    assert.doesNotMatch(practice.text, /Optional earlier relational-map revisit/);
    const prober = await runTool(host.nativeTools("chat-map", "prober"), "learning_path_get_brief", {});
    assert.doesNotMatch(prober.text, /Optional earlier relational-map revisit/);
    await host.call("sessions.link", {
      pathId: path.id,
      nodeId: "n-concept",
      chatId: "chat-concept",
      kind: "teaching",
    });
    const nonRelational = await runTool(host.nativeTools("chat-concept", "teacher"), "learning_path_get_brief", {});
    assert.doesNotMatch(nonRelational.text, /Optional earlier relational-map revisit/);

    for (const nodeType of ["skill", "bridge"]) {
      const nodeId = `n-${nodeType}`;
      await host.call("paths.updateNode", { pathId: path.id, nodeId, artifactType: "relational_map" });
      await host.call("sessions.unlink", { pathId: path.id, nodeId: "n-contrast", chatId: "chat-map" });
      await host.call("sessions.link", { pathId: path.id, nodeId, chatId: "chat-map", kind: "teaching" });
      const overridden = await runTool(teacher, "learning_path_get_brief", {});
      assert.match(overridden.text, /Recommended: .*\(relational_map\)/);
      assert.doesNotMatch(overridden.text, /Optional earlier relational-map revisit/, nodeType);
      await host.call("sessions.unlink", { pathId: path.id, nodeId, chatId: "chat-map" });
      await host.call("sessions.link", { pathId: path.id, nodeId: "n-contrast", chatId: "chat-map", kind: "teaching" });
    }

    await host.call("settings.save", { artifactDefaults: {}, mapRevisitEnabled: false });
    assert.equal(host.instructions.some((entry) => /learner-first.*map revisit/i.test(entry.text)), false);
    assert.doesNotMatch((await runTool(teacher, "learning_path_get_brief", {})).text, /Optional earlier relational-map revisit/);
  } finally { close(host, directory); }
});

test("deleted native chats stop injection even while the plugin link remains", async () => {
  const { host, directory } = hostWithPath([chat("chat-1")]);
  try {
    assert.equal(host.nativeTools("chat-1", "teacher").length, 6);
    // Keep a turn's tools alive, then delete the host-owned chat.
    const tools = host.nativeTools("chat-1", "teacher");
    assert.equal(host.removeChat("chat-1"), true);
    assert.deepEqual(host.nativeTools("chat-1", "teacher"), []);
    const result = await runTool(tools, "learning_path_update_progress", {
      progression: "in_progress",
    });
    assert.equal(result.isError, true);
    assert.match(result.text, /no longer exists/);
  } finally {
    close(host, directory);
  }
});

test("linked sessions receive the node brief with source anchor, artifacts and upstream watchpoints", async () => {
  const { host, directory } = hostWithPath([chat("chat-contrast")]);
  try {
    await host.call("sessions.link", {
      pathId: "path-linear-algebra",
      nodeId: "n-contrast",
      chatId: "chat-contrast",
      kind: "teaching",
    });
    const tools = host.nativeTools("chat-contrast", "teacher");
    const result = await runTool(tools, "learning_path_get_brief", {});
    assert.equal(result.isError, false);

    assert.equal(result.details.nodeId, "n-contrast");
    assert.equal(result.details.nodeTitle, "Node n-contrast");
    assert.deepEqual(
      (result.details.interleaved as { nodeId: string }[]).map((entry) => entry.nodeId),
      ["n-concept", "n-skill"],
    );
    const watchpoints = result.details.watchpoints as { nodeId: string; summary: string }[];
    assert.deepEqual(
      watchpoints.map((entry) => entry.nodeId),
      ["n-skill"],
      "the unresolved upstream error travels forward as a watchpoint",
    );
    assert.match(watchpoints[0]!.summary, /Drops a sign/);
    assert.equal((result.details.artifact as { type: string }).type, "retrieval_cue");
    assert.match(result.text, /# Learning Path child session brief/);
    assert.match(result.text, /Anchor: OSTEP — chapter 26, section 27\.1, pages 301-320/);
    assert.match(result.text, /Drops a sign while expanding\./);
    assert.match(result.text, /Retrieval cue/);
    assert.match(result.text, /Never restructure the path yourself/);
  } finally {
    close(host, directory);
  }
});

test("progress, errors and advisory pivots persist without restructuring the path", async () => {
  const { host, directory } = hostWithPath([chat("chat-1")]);
  try {
    const tools = host.nativeTools("chat-1", "teacher");

    const progress = await runTool(tools, "learning_path_update_progress", {
      progression: "consolidated",
      artifactNote: "Wrote the smallest failing interpreter.",
    });
    assert.equal(progress.isError, false);
    assert.equal(progress.details.progression, "consolidated");
    let saved = savedPath(directory);
    let node = saved.modules[0]!.nodes.find((entry) => entry.id === "n-concept")!;
    assert.equal(node.progression, "consolidated");
    assert.equal(node.artifactNote, "Wrote the smallest failing interpreter.");

    const logged = await runTool(tools, "learning_path_log_error", {
      category: "misconception",
      summary: "Treats the diagram as the proof.",
    });
    assert.equal(logged.isError, false);
    assert.equal(logged.details.sessionChatId, "chat-1");
    saved = savedPath(directory);
    node = saved.modules[0]!.nodes.find((entry) => entry.id === "n-concept")!;
    const entry = node.errors.at(-1)!;
    assert.equal(entry.category, "misconception");
    assert.equal(entry.resolved, false);
    assert.equal(entry.sessionChatId, "chat-1");

    const upstream = await runTool(tools, "learning_path_log_error", {
      category: "cue_failure",
      summary: "Did not recognise the holistic map when unlabelled.",
      upstreamNodeId: "n-holistic",
    });
    assert.equal(upstream.isError, false);
    saved = savedPath(directory);
    const holistic = saved.modules[0]!.nodes.find((entry) => entry.id === "n-holistic")!;
    assert.equal(holistic.errors.at(-1)!.category, "cue_failure");

    const badUpstream = await runTool(tools, "learning_path_log_error", {
      category: "cue_failure",
      summary: "Not interleaved with this node.",
      upstreamNodeId: "n-checkpoint",
    });
    assert.equal(badUpstream.isError, true);
    assert.match(badUpstream.text, /not an interleaved earlier node/);

    const before = savedPath(directory);
    const beforeStructure = before.modules.map((module) => ({
      id: module.id,
      nodes: module.nodes.map((candidate) => candidate.id),
    }));
    const pivot = await runTool(tools, "learning_path_suggest_pivot", {
      proposalType: "skill",
      title: "Add a sign-tracking drill",
      rationale: "Mechanics keep slipping while the idea is understood.",
    });
    assert.equal(pivot.isError, false);
    assert.equal(pivot.details.status, "pending");
    assert.equal(pivot.details.advisory, true);
    assert.equal(pivot.details.pathMutated, false);
    saved = savedPath(directory);
    assert.deepEqual(
      saved.modules.map((module) => ({
        id: module.id,
        nodes: module.nodes.map((candidate) => candidate.id),
      })),
      beforeStructure,
      "a pivot never inserts, reorders or deletes a node",
    );
    node = saved.modules[0]!.nodes.find((entry) => entry.id === "n-concept")!;
    const suggestion = node.pivotSuggestions.at(-1)!;
    assert.equal(suggestion.status, "pending");
    assert.equal(suggestion.proposalType, "skill");
    assert.equal(suggestion.insertedNodeId, undefined);

    const holisticPivot = await runTool(tools, "learning_path_suggest_pivot", {
      proposalType: "holistic",
      title: "Rebuild the map",
      rationale: "Out of scope for a child-session pivot.",
    });
    assert.equal(holisticPivot.isError, true);
  } finally {
    close(host, directory);
  }
});

test("enabled graph context reaches teacher/practice tool briefs and search, never launch prompts or prober", async () => {
  const directory = temporaryDirectory();
  const fixture = makePath();
  const path = { ...fixture, modules: fixture.modules.map(module => ({ ...module, nodes: module.nodes.map(node => node.id === "n-concept"
    ? { ...node, title: "Concurrency", goal: "Distinguish concurrency from parallelism" } : node) })) };
  const store = openLearningPathStore(directory);
  store.savePath(path);
  const proposition = { id: "prior", name: "Concurrency", statement: "Concurrency allows independent tasks to overlap.", aliases: [], createdAt: AT, provenance: [] };
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-1"), chat("practice", "practice"), chat("unlinked")], graph: () => [proposition] });
  try {
    const offBrief = await runTool(host.nativeTools("chat-1", "teacher"), "learning_path_get_brief", {});
    assert.doesNotMatch(offBrief.text, /Graph context/);
    await host.call("settings.save", { artifactDefaults: {}, graphContextEnabled: true });
    const tools = host.nativeTools("chat-1", "teacher");
    const brief = await runTool(tools, "learning_path_get_brief", {});
    assert.match(brief.text, /Concurrency allows independent tasks to overlap/);
    const savedBeforeSearch = openLearningPathStore(directory).path(path.id);
    const result = await runTool(tools, "learning_path_search_graph", { query: "concurrency" });
    assert.deepEqual(openLearningPathStore(directory).path(path.id), savedBeforeSearch, "reads never mutate path or progression");
    assert.equal(result.isError, false);
    assert.deepEqual(result.details.propositions, [{ id: "prior", statement: proposition.statement }]);
    assert.match(result.text, /never state a connection before the learner has tried/);
    assert.equal(host.nativeTools("chat-1", "prober").length, 6);
    const prober = await runTool(host.nativeTools("chat-1", "prober"), "learning_path_get_brief", {});
    assert.equal(prober.text, offBrief.text);
    assert.deepEqual(host.nativeTools("unlinked", "teacher"), []);
    await host.call("sessions.link", { pathId: path.id, nodeId: "n-concept", chatId: "practice", kind: "practice" });
    assert.ok(host.nativeTools("practice", "practice").some(t => t.name === "learning_path_search_graph"));
    const prepared = await host.call<{ prompt: string }>("sessions.prepare", { pathId: path.id, nodeId: "n-concept", kind: "teaching" });
    assert.doesNotMatch(prepared.prompt, /Concurrency allows independent tasks to overlap|Graph context/);
    assert.ok(host.instructions.some(entry => !entry.agents.includes("prober") && /Prefer unlabelled/.test(entry.text)));
  } finally { close(host, directory); }
});

test("graph context safely falls back and stale tools cannot read after disabling, unlinking or deletion", async () => {
  const directory = temporaryDirectory();
  openLearningPathStore(directory).savePath(makePath());
  let mode: "ready" | "empty" | "throw" | "missing" = "ready";
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-1")], graph: () => {
    if (mode === "throw") throw new Error("graph locked");
    if (mode === "missing") return undefined as never;
    return mode === "empty" ? [] : [{ id: "p1", name: "First principles", statement: "First principles reconstruct a concept from its foundations.", aliases: [], createdAt: AT, provenance: [] }];
  } });
  try {
    const baseTools = host.nativeTools("chat-1", "teacher");
    const baseline = await runTool(baseTools, "learning_path_get_brief", {});
    await host.call("settings.save", { artifactDefaults: {}, graphContextEnabled: true });
    const tools = host.nativeTools("chat-1", "teacher");
    assert.equal(tools.length, 7);
    for (const fallback of ["empty", "throw", "missing"] as const) {
      mode = fallback;
      assert.deepEqual(host.nativeTools("chat-1", "teacher").map(t => t.name), baseTools.map(t => t.name));
      assert.equal((await runTool(tools, "learning_path_get_brief", {})).text, baseline.text);
      assert.deepEqual((await runTool(tools, "learning_path_search_graph", { query: "principles" })).details.propositions, []);
    }
    mode = "ready";
    await host.call("settings.save", { artifactDefaults: {}, graphContextEnabled: false });
    assert.equal(host.instructions.length, 1);
    assert.deepEqual((await runTool(tools, "learning_path_search_graph", { query: "principles" })).details.propositions, []);
    assert.equal((await runTool(tools, "learning_path_get_brief", {})).text, baseline.text);
    await host.call("settings.save", { artifactDefaults: {}, graphContextEnabled: true });
    await host.call("sessions.unlink", { pathId: "path-linear-algebra", nodeId: "n-concept", chatId: "chat-1" });
    assert.deepEqual((await runTool(tools, "learning_path_search_graph", { query: "principles" })).details.propositions, []);
    await host.call("sessions.link", { pathId: "path-linear-algebra", nodeId: "n-concept", chatId: "chat-1", kind: "teaching" });
    host.removeChat("chat-1");
    assert.deepEqual((await runTool(tools, "learning_path_search_graph", { query: "principles" })).details.propositions, []);
    await host.cleanup();
    assert.equal(host.instructions.length, 0);
  } finally { close(host, directory); }
});

test("graph search matches recorded aliases and bounds results, fields, scan and invalid inputs", async () => {
  const directory = temporaryDirectory();
  const store = openLearningPathStore(directory);
  store.savePath(makePath());
  store.saveSettings({ artifactDefaults: {}, graphContextEnabled: true });
  const proposition = (id: string, statement: string, aliases: string[] = []) => ({ id, name: "display label", statement, aliases, createdAt: AT, provenance: [] });
  const propositions = [
    proposition("alias", "Separate tasks can advance during overlapping intervals.", ["concurrencia"]),
    ...Array.from({ length: 7 }, (_, i) => proposition(`bounded-${i}`, `bounded ${"x".repeat(5_000)}`)),
    ...Array.from({ length: 9_992 }, (_, i) => proposition(`none-${i}`, "Unrelated recorded evidence.")),
    proposition("past-scan", "beyondscan match"),
  ];
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-1")], graph: () => propositions });
  try {
    const tools = host.nativeTools("chat-1", "teacher");
    const alias = await runTool(tools, "learning_path_search_graph", { query: "CONCURRENCIA" });
    assert.deepEqual(alias.details.propositions, [{ id: "alias", statement: "Separate tasks can advance during overlapping intervals." }]);
    const bounded = await runTool(tools, "learning_path_search_graph", { query: "bounded" });
    const entries = bounded.details.propositions as { id: string; statement: string }[];
    assert.equal(entries.length, 5);
    assert.ok(entries.every(entry => entry.statement.length <= 600));
    assert.ok(bounded.text.length < 8_000);
    assert.deepEqual((await runTool(tools, "learning_path_search_graph", { query: "beyondscan" })).details.propositions, []);
    assert.deepEqual((await runTool(tools, "learning_path_search_graph", { query: "the and of" })).details.propositions, []);
    for (const query of ["", "x".repeat(501), 123]) {
      assert.equal((await runTool(tools, "learning_path_search_graph", { query })).isError, true);
    }
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(() => toolByName(tools, "learning_path_search_graph").execute("cancelled", { query: "bounded" }, cancelled.signal), /shutting down/);
  } finally { close(host, directory); }
});

test("a frozen teacher brief stops graph access if the chat is relinked as practice", async () => {
  const directory = temporaryDirectory();
  const store = openLearningPathStore(directory);
  store.savePath(makePath());
  store.saveSettings({ artifactDefaults: {}, graphContextEnabled: true });
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-1")], graph: () => [{ id: "private", name: "First principles", statement: "First principles are private recorded context.", aliases: [], createdAt: AT, provenance: [] }] });
  try {
    const teacherTools = host.nativeTools("chat-1", "teacher");
    await host.call("sessions.unlink", { pathId: "path-linear-algebra", nodeId: "n-concept", chatId: "chat-1" });
    host.addChat(chat("chat-1", "practice"));
    await host.call("sessions.link", { pathId: "path-linear-algebra", nodeId: "n-concept", chatId: "chat-1", kind: "practice" });
    const stale = await runTool(teacherTools, "learning_path_get_brief", {});
    assert.doesNotMatch(stale.text, /private recorded context/);
    assert.deepEqual((await runTool(teacherTools, "learning_path_search_graph", { query: "principles" })).details.propositions, []);
  } finally { close(host, directory); }
});

test("recorded aliases remain searchable when the proposition statement exceeds its matching budget", async () => {
  const directory = temporaryDirectory();
  const store = openLearningPathStore(directory);
  store.savePath(makePath());
  store.saveSettings({ artifactDefaults: {}, graphContextEnabled: true });
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-1")], graph: () => [{
    id: "long", name: "Long proposition", statement: `A long recorded proposition ${"x".repeat(5_000)}`, aliases: ["concurrency"], createdAt: AT, provenance: [],
  }] });
  try {
    const result = await runTool(host.nativeTools("chat-1", "teacher"), "learning_path_search_graph", { query: "concurrency" });
    assert.equal((result.details.propositions as unknown[]).length, 1);
  } finally { close(host, directory); }
});

test("graph briefs and search exclude current-chat-only evidence before ranking but retain mixed and unknown provenance", async () => {
  const directory = temporaryDirectory();
  const fixture = makePath();
  const path = { ...fixture, modules: fixture.modules.map(module => ({ ...module, nodes: module.nodes.map(node => node.id === "n-concept"
    ? { ...node, title: "Concurrency", goal: "Distinguish concurrency from parallelism" } : node) })) };
  const store = openLearningPathStore(directory);
  store.savePath(path);
  store.saveSettings({ artifactDefaults: {}, graphContextEnabled: true });
  const proposition = (id: string, statement: string, chatIds: string[]) => ({ id, name: id, statement, aliases: [], createdAt: AT,
    provenance: chatIds.map(chatId => ({ chatId, messageId: "message-1" })) });
  const propositions = [
    ...Array.from({ length: 6 }, (_, i) => proposition(`current-${i}`, "Concurrency parallelism CURRENT_ONLY evidence.", ["chat-1"])),
    proposition("mixed", "Concurrency MIXED evidence.", ["chat-1", "earlier-chat"]),
    proposition("other", "Concurrency EARLIER evidence.", ["earlier-chat"]),
    proposition("unknown", "Concurrency UNKNOWN evidence.", []),
    proposition("imported", "Concurrency IMPORTED evidence.", ["src_notes"]),
  ];
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-1")], graph: () => propositions });
  try {
    const tools = host.nativeTools("chat-1", "teacher");
    const brief = await runTool(tools, "learning_path_get_brief", {});
    assert.doesNotMatch(brief.text, /CURRENT_ONLY/);
    for (const marker of ["MIXED", "EARLIER", "UNKNOWN", "IMPORTED"]) assert.match(brief.text, new RegExp(marker));
    const search = await runTool(tools, "learning_path_search_graph", { query: "concurrency parallelism" });
    assert.deepEqual((search.details.propositions as { id: string }[]).map(entry => entry.id), ["imported", "mixed", "other", "unknown"]);
  } finally { close(host, directory); }
});

test("the workspace read tool serves bounded UTF-16 windows and the brief lists titles only", async () => {
  const directory = temporaryDirectory();
  const store = openLearningPathStore(directory);
  store.savePath(makePath());
  const markdown = "x".repeat(30_000) + "THE-TAIL";
  const saved = store.saveWorkspaceItem(
    "path-linear-algebra",
    makeItem({ links: [{ to: "n-skill", rel: "informs" }] }),
    markdown,
  );
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-skill", "practice")] });
  try {
    await host.call("sessions.link", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      chatId: "chat-skill",
      kind: "practice",
    });
    const tools = host.nativeTools("chat-skill", "practice");
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...LEARNING_PATH_TOOL_NAMES],
      "the read tool ships with the standard linked-session loadout",
    );

    const first = await runTool(tools, "learning_path_read_workspace_item", { itemId: saved.id });
    assert.equal(first.isError, false);
    assert.equal(first.details.totalCharacters, markdown.length);
    assert.equal(first.details.chunkStart, 0);
    assert.equal((first.details.chunkEnd as number) > 0, true);
    const chunkEnd = first.details.chunkEnd as number;
    assert.equal(first.details.nextOffset, chunkEnd);
    assert.equal((first.details.text as string).length, chunkEnd);

    const window = await runTool(tools, "learning_path_read_workspace_item", {
      itemId: saved.id,
      offset: chunkEnd,
      limit: 100,
    });
    assert.equal(window.details.chunkStart, chunkEnd);
    assert.equal(window.details.text, markdown.slice(chunkEnd, chunkEnd + 100));

    // The window past the end clamps and reports nextOffset null.
    const tail = await runTool(tools, "learning_path_read_workspace_item", {
      itemId: saved.id,
      offset: markdown.length - 8,
      limit: 20_000,
    });
    assert.equal(tail.details.text, "THE-TAIL");
    assert.equal(tail.details.nextOffset, null);

    const unknown = await runTool(tools, "learning_path_read_workspace_item", {
      itemId: "11111111-1111-1111-1111-111111111111",
    });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /Unknown workspace item/);
    assert.match(unknown.text, new RegExp(saved.id), "the error lists the known items");

    const badOffset = await runTool(tools, "learning_path_read_workspace_item", {
      itemId: saved.id,
      offset: -1,
    });
    assert.match(badOffset.text, /offset must be a non-negative integer/);

    // The brief lists the material by kind and title only; content stays behind the tool.
    const brief = await runTool(tools, "learning_path_get_brief", {});
    assert.match(brief.text, /## Learner workspace material/);
    assert.match(brief.text, /- note: Feynman notes on vector spaces/);
    assert.doesNotMatch(brief.text, new RegExp(markdown.slice(0, 40)), "content never enters the brief");
    assert.doesNotMatch(brief.text, new RegExp(saved.id), "the brief carries titles, not ids");
  } finally {
    close(host, directory);
  }
});

test("the workspace read tool reads source items from the library, and stops for unlinked chats", async () => {
  const directory = temporaryDirectory();
  const store = openLearningPathStore(directory);
  store.savePath(makePath());
  store.saveSource({ name: "paper.md", markdown: "source body" });
  store.saveWorkspaceItem(
    "path-linear-algebra",
    {
      kind: "source",
      title: "A paper",
      addedBy: "learner",
      sourceId: store.sources()[0]!.sourceId,
      links: [{ to: "n-skill", rel: "grounds" }],
    },
  );
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-skill", "practice")] });
  try {
    await host.call("sessions.link", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      chatId: "chat-skill",
      kind: "practice",
    });
    const tools = host.nativeTools("chat-skill", "practice");
    const sourceItem = store.workspace("path-linear-algebra")!.items[0]!;
    // A filed document reads from the global source library under the same
    // bounded window as every other kind — the manifest never copies content.
    const source = await runTool(tools, "learning_path_read_workspace_item", { itemId: sourceItem.id });
    assert.equal(source.details.totalCharacters, "source body".length);
    assert.equal(source.details.text, "source body");
    assert.equal(source.details.kind, "source");
    assert.equal(source.details.nextOffset, null);

    await host.call("sessions.unlink", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      chatId: "chat-skill",
    });
    const afterUnlink = await runTool(tools, "learning_path_read_workspace_item", {
      itemId: "11111111-1111-1111-1111-111111111111",
    });
    assert.match(afterUnlink.text, /no longer linked to a Learning Path node/);

    host.removeChat("chat-skill");
    const afterDelete = await runTool(tools, "learning_path_read_workspace_item", { itemId: sourceItem.id });
    assert.match(afterDelete.text, /no longer exists/);
  } finally {
    close(host, directory);
  }
});

test("save_artifact stores the full artifact text with session provenance and a produced_by link", async () => {
  const directory = temporaryDirectory();
  const store = openLearningPathStore(directory);
  store.savePath(makePath());
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-1")] });
  try {
    await host.call("sessions.link", {
      pathId: "path-linear-algebra",
      nodeId: "n-concept",
      chatId: "chat-1",
      kind: "teaching",
    });
    const tools = host.nativeTools("chat-1", "teacher");
    const markdown = "# Relational map\n\n- queues -> schedulers";
    const saved = await runTool(tools, "learning_path_save_artifact", {
      title: "My concurrency map",
      content: markdown,
    });
    assert.equal(saved.isError, false);
    assert.equal(saved.details.nodeId, "n-concept");
    assert.equal(saved.details.kind, "session_artifact");
    assert.equal(saved.details.addedBy, "session:chat-1");
    assert.deepEqual(saved.details.links, [{ to: "n-concept", rel: "produced_by" }]);
    const itemId = saved.details.itemId as string;

    const workspace = openLearningPathStore(directory).workspace("path-linear-algebra");
    assert.ok(workspace, "the save materializes the workspace");
    const item = workspace.items.find((candidate) => candidate.id === itemId);
    assert.ok(item);
    assert.equal(item.kind, "session_artifact");
    assert.equal(item.title, "My concurrency map");
    assert.equal(item.addedBy, "session:chat-1");
    assert.deepEqual([...item.links], [{ to: "n-concept", rel: "produced_by" }]);
    assert.equal(openLearningPathStore(directory).readWorkspaceItemContent("path-linear-algebra", itemId), markdown);

    // Saving is never a gate: the path record itself is untouched.
    const path = savedPath(directory);
    const node = path.modules[0]!.nodes.find((entry) => entry.id === "n-concept")!;
    assert.equal(node.progression, "in_progress");
    assert.equal(node.artifactNote, undefined);
    assert.equal(node.errors.length, 0);

    // artifactNote keeps working exactly as before, alongside the saved item.
    const progress = await runTool(tools, "learning_path_update_progress", {
      progression: "consolidated",
      artifactNote: "Wrote the smallest failing interpreter.",
    });
    assert.equal(progress.isError, false);
    assert.equal(progress.details.artifactNote, "Wrote the smallest failing interpreter.");
    const after = savedPath(directory).modules[0]!.nodes.find((entry) => entry.id === "n-concept")!;
    assert.equal(after.artifactNote, "Wrote the smallest failing interpreter.");
    assert.equal(after.progression, "consolidated");
  } finally {
    close(host, directory);
  }
});

test("save_artifact defaults its title, feeds the brief titles-only, and refuses bad input or vanished chats", async () => {
  const directory = temporaryDirectory();
  const store = openLearningPathStore(directory);
  store.savePath(makePath());
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-1")] });
  try {
    await host.call("sessions.link", {
      pathId: "path-linear-algebra",
      nodeId: "n-concept",
      chatId: "chat-1",
      kind: "teaching",
    });
    const tools = host.nativeTools("chat-1", "teacher");
    const defaulted = await runTool(tools, "learning_path_save_artifact", {
      content: "smallest failing interpreter",
    });
    assert.equal(defaulted.isError, false);
    assert.match(defaulted.details.itemTitle as string, /^Node n-concept — /);

    // The brief lists the saved artifact by kind and title only.
    const brief = await runTool(tools, "learning_path_get_brief", {});
    assert.match(brief.text, /- session_artifact: Node n-concept — /);

    const blank = await runTool(tools, "learning_path_save_artifact", { content: "   " });
    assert.equal(blank.isError, true);
    assert.match(blank.text, /content must not be blank/);

    const oversized = await runTool(tools, "learning_path_save_artifact", {
      content: "x".repeat(256 * 1024 + 1),
    });
    assert.equal(oversized.isError, true);
    assert.match(oversized.text, /at most/);

    await host.call("sessions.unlink", {
      pathId: "path-linear-algebra",
      nodeId: "n-concept",
      chatId: "chat-1",
    });
    const afterUnlink = await runTool(tools, "learning_path_save_artifact", { content: "still produced" });
    assert.equal(afterUnlink.isError, true);
    assert.match(afterUnlink.text, /no longer linked to a Learning Path node/);

    host.removeChat("chat-1");
    const afterDelete = await runTool(tools, "learning_path_save_artifact", { content: "still produced" });
    assert.equal(afterDelete.isError, true);
    assert.match(afterDelete.text, /no longer exists/);
  } finally {
    close(host, directory);
  }
});

test("map revisit cites the learner's saved relational maps instead of a redraw from memory", async () => {
  const directory = temporaryDirectory();
  const path = { ...makePath(), artifactDefault: null };
  openLearningPathStore(directory).savePath(path);
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-map"), chat("chat-other"), chat("chat-concept")] });
  try {
    await host.call("settings.save", { artifactDefaults: {}, mapRevisitEnabled: true });
    await host.call("sessions.link", {
      pathId: path.id,
      nodeId: "n-contrast",
      chatId: "chat-map",
      kind: "teaching",
    });

    // No saved map yet: the original supply-an-earlier-map brief applies.
    const before = await runTool(host.nativeTools("chat-map", "teacher"), "learning_path_get_brief", {});
    assert.match(before.text, /supply an earlier map of their choice/);

    // Another session on the same node saves its map; provenance is its own chat.
    await host.call("sessions.link", {
      pathId: path.id,
      nodeId: "n-contrast",
      chatId: "chat-other",
      kind: "teaching",
    });
    const saved = await runTool(host.nativeTools("chat-other", "teacher"), "learning_path_save_artifact", {
      title: "First relational map",
      content: "# Map of the earlier session",
    });
    assert.equal(saved.isError, false);

    const after = await runTool(host.nativeTools("chat-map", "teacher"), "learning_path_get_brief", {});
    assert.match(after.text, /earlier relational map they saved in this path's workspace/);
    assert.match(after.text, /"First relational map"/);
    assert.match(after.text, /learning_path_read_workspace_item/);
    assert.doesNotMatch(after.text, /# Map of the earlier session/, "titles only; content stays behind the tool");
    assert.match(after.text, /Never scrape transcripts, treat artifactNote as the full map/);

    // A different node's saved artifact never leaks into this brief.
    await host.call("sessions.link", {
      pathId: path.id,
      nodeId: "n-concept",
      chatId: "chat-concept",
      kind: "teaching",
    });
    await runTool(host.nativeTools("chat-concept", "teacher"), "learning_path_save_artifact", {
      title: "Concept-node artifact",
      content: "not a map for n-contrast",
    });
    const unaffected = await runTool(host.nativeTools("chat-map", "teacher"), "learning_path_get_brief", {});
    assert.match(unaffected.text, /"First relational map"/);
    assert.doesNotMatch(unaffected.text, /"Concept-node artifact"/);
  } finally {
    close(host, directory);
  }
});

test("the workspace read tool serves linked items only: unlinked material is never agent context", async () => {
  const directory = temporaryDirectory();
  const store = openLearningPathStore(directory);
  store.savePath(makePath());
  // The learner's private scratchpad: unlinked, and linked to a different
  // node than the one this session teaches.
  const unlinked = store.saveWorkspaceItem(
    "path-linear-algebra",
    makeItem({ id: ITEM_ID_2, title: "Private scratchpad", links: [] }),
    "never enters agent context",
  );
  const otherNode = store.saveWorkspaceItem(
    "path-linear-algebra",
    makeItem({ id: ITEM_ID_3, title: "Filed under another node", links: [{ to: "n-concept", rel: "informs" }] }),
    "filed elsewhere",
  );
  const linked = store.saveWorkspaceItem(
    "path-linear-algebra",
    makeItem({ id: ITEM_ID_4, title: "Filed under this node", links: [{ to: "n-skill", rel: "informs" }] }),
    "agent-readable",
  );
  const host = createHost({ dataDirectory: directory, chats: [chat("chat-skill", "practice")] });
  try {
    await host.call("sessions.link", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      chatId: "chat-skill",
      kind: "practice",
    });
    const tools = host.nativeTools("chat-skill", "practice");

    const refusedUnlinked = await runTool(tools, "learning_path_read_workspace_item", { itemId: unlinked.id });
    assert.equal(refusedUnlinked.isError, true);
    assert.match(refusedUnlinked.text, /is not linked to this node/);
    assert.doesNotMatch(refusedUnlinked.text, /never enters agent context/, "the body never leaks through the error");
    assert.match(refusedUnlinked.text, new RegExp(linked.id), "the error offers the linked items instead");

    const refusedOther = await runTool(tools, "learning_path_read_workspace_item", { itemId: otherNode.id });
    assert.equal(refusedOther.isError, true);
    assert.match(refusedOther.text, /is not linked to this node/);

    const served = await runTool(tools, "learning_path_read_workspace_item", { itemId: linked.id });
    assert.equal(served.isError, false);
    assert.equal(served.details.text, "agent-readable");
  } finally {
    close(host, directory);
  }
});
