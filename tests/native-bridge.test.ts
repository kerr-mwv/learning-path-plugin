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
import { makePath, AT } from "./fixtures.ts";
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
    assert.equal(host.nativeTools("chat-1", "prober").length, 4);
    assert.deepEqual(host.nativeTools("chat-1", "practice"), [], "teaching chats do not feed practice");

    const practice = host.nativeTools("chat-practice", "practice");
    assert.equal(practice.length, 4);
    assert.deepEqual(host.nativeTools("chat-practice", "teacher"), []);
  } finally {
    close(host, directory);
  }
});

test("deleted native chats stop injection even while the plugin link remains", async () => {
  const { host, directory } = hostWithPath([chat("chat-1")]);
  try {
    assert.equal(host.nativeTools("chat-1", "teacher").length, 4);
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
