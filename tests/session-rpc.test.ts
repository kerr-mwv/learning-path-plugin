/** Child-session backend operations.
 *
 * Verifies the JSON bridge the Path Hub and top-bar actions use: opening-prompt
 * preparation, link validation against `ctx.learning.getSession`, parent lookup,
 * available-session listing, and missing/deleted native chat handling.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatRecord } from "learnharness-plugin-api";
import { openLearningPathStore } from "../src/store.ts";
import { AT, makePath } from "./fixtures.ts";
import { createHost } from "./host.ts";
import type { TestHost } from "./host.ts";
import { EVENT_PATHS_CHANGED } from "../src/topics.ts";

function chat(id: string, kind: "teach" | "practice" = "teach", title = id): ChatRecord {
  return { id, title, createdAt: AT, updatedAt: AT, messages: [], kind };
}

function hostWithPath(chats: readonly ChatRecord[]): { host: TestHost; directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-rpc-"));
  openLearningPathStore(directory).savePath(makePath());
  return { host: createHost({ dataDirectory: directory, chats }), directory };
}

function close(host: TestHost, directory: string): void {
  host.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

test("sessions.prepare builds the node title and tailored opening prompt", async () => {
  const { host, directory } = hostWithPath([chat("chat-new")]);
  try {
    const prepared = await host.call<{
      title: string;
      prompt: string;
      nodeTitle: string;
      watchpoints: number;
    }>("sessions.prepare", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      kind: "practice",
    });
    assert.equal(prepared.title, "Practice: Node n-skill");
    assert.equal(prepared.nodeTitle, "Node n-skill");
    assert.match(prepared.prompt, /You are opening a practice session/);
    assert.match(prepared.prompt, /Drops a sign while expanding/);
    assert.equal(prepared.watchpoints, 1);

    await assert.rejects(
      () =>
        host.call("sessions.prepare", {
          pathId: "path-linear-algebra",
          nodeId: "missing-node",
          kind: "teaching",
        }),
      /Unknown node/,
    );
  } finally {
    close(host, directory);
  }
});

test("sessions.link validates existence, kind and duplicates, then persists one link", async () => {
  const { host, directory } = hostWithPath([
    chat("chat-teach"),
    chat("chat-practice", "practice"),
    chat("chat-other"),
  ]);
  try {
    await assert.rejects(
      () =>
        host.call("sessions.link", {
          pathId: "path-linear-algebra",
          nodeId: "n-skill",
          chatId: "chat-deleted",
          kind: "teaching",
        }),
      /no longer exists/,
    );

    await assert.rejects(
      () =>
        host.call("sessions.link", {
          pathId: "path-linear-algebra",
          nodeId: "n-skill",
          chatId: "chat-teach",
          kind: "practice",
        }),
      /is a teaching session, not practice/,
    );

    const linked = await host.call<{
      link: { chatId: string; kind: string; label: string; createdAt: string };
      deduplicated: boolean;
    }>("sessions.link", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      chatId: "chat-teach",
      kind: "teaching",
      label: "Sign drill",
    });
    assert.equal(linked.deduplicated, false);
    assert.equal(linked.link.chatId, "chat-teach");
    assert.equal(linked.link.label, "Sign drill");
    assert.ok(host.events.some((event) => event.topic === EVENT_PATHS_CHANGED));

    const stored = openLearningPathStore(directory).path("path-linear-algebra")!;
    const node = stored.modules[0]!.nodes.find((entry) => entry.id === "n-skill")!;
    assert.deepEqual(node.childSessions.map((entry) => entry.chatId), ["chat-teach"]);

    const again = await host.call<{ deduplicated: boolean }>("sessions.link", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      chatId: "chat-teach",
      kind: "teaching",
    });
    assert.equal(again.deduplicated, true);

    await assert.rejects(
      () =>
        host.call("sessions.link", {
          pathId: "path-linear-algebra",
          nodeId: "n-concept",
          chatId: "chat-teach",
          kind: "teaching",
        }),
      /already linked to "Node n-skill"/,
    );

    await host.call("sessions.link", {
      pathId: "path-linear-algebra",
      nodeId: "n-concept",
      chatId: "chat-practice",
      kind: "practice",
    });
  } finally {
    close(host, directory);
  }
});

test("sessions.forChat and sessions.available expose the parent and linked state", async () => {
  const { host, directory } = hostWithPath([
    chat("chat-1", "teach", "First teaching chat"),
    chat("chat-free", "practice", "Free practice"),
  ]);
  try {
    const parent = await host.call<{
      link: { pathId: string; nodeId: string; nodeTitle: string } | null;
      exists: boolean;
    }>("sessions.forChat", { chatId: "chat-1" });
    assert.equal(parent.exists, true);
    assert.equal(parent.link?.pathId, "path-linear-algebra");
    assert.equal(parent.link?.nodeId, "n-concept");
    assert.equal(parent.link?.nodeTitle, "Node n-concept");

    const free = await host.call<{ link: unknown }>("sessions.forChat", {
      chatId: "chat-free",
    });
    assert.equal(free.link, null);

    const available = await host.call<{
      sessions: {
        chatId: string;
        kind: string;
        linked: { nodeId: string } | null;
      }[];
    }>("sessions.available", {});
    assert.deepEqual(
      available.sessions.map((entry) => [entry.chatId, entry.kind, entry.linked?.nodeId ?? null]),
      [
        ["chat-1", "teaching", "n-concept"],
        ["chat-free", "practice", null],
      ],
    );
  } finally {
    close(host, directory);
  }
});

test("deleted chats are reported missing; unlinking removes only the plugin record", async () => {
  const { host, directory } = hostWithPath([chat("chat-1"), chat("chat-extra")]);
  try {
    await host.call("sessions.link", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      chatId: "chat-extra",
      kind: "teaching",
    });
    let status = await host.call<{ sessions: { chatId: string; exists: boolean }[] }>(
      "sessions.status",
      { pathId: "path-linear-algebra" },
    );
    assert.deepEqual(
      status.sessions.map((entry) => [entry.chatId, entry.exists]),
      [
        ["chat-1", true],
        ["chat-extra", true],
      ],
    );

    host.removeChat("chat-extra");
    status = await host.call("sessions.status", { pathId: "path-linear-algebra" });
    assert.deepEqual(
      status.sessions.map((entry) => [entry.chatId, entry.exists]),
      [
        ["chat-1", true],
        ["chat-extra", false],
      ],
    );
    const parent = await host.call<{ link: unknown; exists: boolean }>("sessions.forChat", {
      chatId: "chat-extra",
    });
    assert.equal(parent.exists, false);
    assert.ok(parent.link);

    const unlinked = await host.call<{
      path: { modules: { nodes: { childSessions: unknown[] }[] }[] };
      removed: boolean;
    }>("sessions.unlink", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      chatId: "chat-extra",
    });
    assert.equal(unlinked.removed, true);
    const stored = openLearningPathStore(directory).path("path-linear-algebra")!;
    const node = stored.modules[0]!.nodes.find((entry) => entry.id === "n-skill")!;
    assert.deepEqual(node.childSessions, []);
    assert.equal(
      openLearningPathStore(directory)
        .path("path-linear-algebra")!
        .modules[0]!.nodes.find((entry) => entry.id === "n-concept")!
        .childSessions.length,
      1,
      "unlinking one node's chat leaves other links intact",
    );
  } finally {
    close(host, directory);
  }
});
