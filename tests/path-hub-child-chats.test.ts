/** Path Hub child-session UI tests.
 *
 * Covers the node-level launch actions, missing/deleted native chat handling and
 * top-bar navigation targets landing on the right node. The native host is
 * injected, so no chat is created and no storage is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginTreeRow } from "learnharness-plugin-api";
import type { NativeSessionHost } from "../src/native-session-host.ts";
import {
  clearPathHubTarget,
  requestPathHubTarget,
} from "../src/session-navigation.ts";
import { mountPathHub } from "../src/view/path-hub.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture } from "./view-host.ts";
import type { ViewFixture } from "./view-host.ts";

function fakeHost(fixture: ViewFixture): NativeSessionHost & {
  created: { title: string; kind: string }[];
  staged: string[];
} {
  const created: { title: string; kind: string }[] = [];
  const staged: string[] = [];
  return {
    created,
    staged,
    async create(input) {
      created.push({ title: input.title, kind: input.kind });
      fixture.nativeChats.set("chat-new", {
        id: "chat-new",
        title: input.title,
        kind: input.kind === "practice" ? "practice" : "teach",
      });
      return { chatId: "chat-new" };
    },
    stageOpeningPrompt(_chatId, text) {
      staged.push(text);
      return true;
    },
    clearOpeningPrompt() {},
  };
}

async function mounted(fixture: ViewFixture, host?: NativeSessionHost): Promise<HTMLElement> {
  mountPathHub(fixture.context, fixture.root, fixture.context.signal, {
    sessionHost: host ?? fakeHost(fixture),
  });
  await fixture.flush();
  await fixture.flush();
  return fixture.root;
}

function row(fixture: ViewFixture, key: string): PluginTreeRow {
  const tree = fixture.find("mountTree");
  const rows: PluginTreeRow[] = [];
  const visit = (entries: readonly PluginTreeRow[]) => {
    for (const entry of entries) {
      rows.push(entry);
      if (entry.children) visit(entry.children);
    }
  };
  visit(tree.props.rows as readonly PluginTreeRow[]);
  const found = rows.find((entry) => entry.key === key);
  assert.ok(found, `Missing row ${key}`);
  return found;
}

function button(fixture: ViewFixture, label: string) {
  const found = fixture.all("mountButton").find((record) => record.props.label === label);
  assert.ok(found, `Missing button ${label}`);
  return found;
}

function inspector(fixture: ViewFixture): HTMLElement {
  const element = fixture.root.querySelector<HTMLElement>(".lp-inspector");
  assert.ok(element);
  return element;
}

test("Start Teaching Chat creates, links, stages and opens a native session", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const host = fakeHost(fixture);
    await mounted(fixture, host);
    await row(fixture, "node:n-skill").selection!.onChange(true);
    await fixture.flush();
    assert.equal(inspector(fixture).dataset.nodeId, "n-skill");

    await button(fixture, "Start Teaching Chat").props.onClick();
    await fixture.flush();
    await fixture.flush();

    assert.deepEqual(host.created, [{ title: "Teaching: Node n-skill", kind: "teaching" }]);
    assert.equal(host.staged.length, 1);
    assert.match(host.staged[0]!, /Node n-skill/);
    assert.deepEqual(fixture.openedSessions, ["chat-new"]);
    const linked = fixture.paths
      .get(path.id)!
      .modules.flatMap((module) => module.nodes)
      .find((node) => node.id === "n-skill")!
      .childSessions.find((entry) => entry.chatId === "chat-new");
    assert.ok(linked);
    assert.match(inspector(fixture).textContent ?? "", /Teaching — Teaching: Node n-skill/);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("a deleted native chat is marked missing and can be unlinked without touching the chat", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    assert.equal(fixture.nativeChats.delete("chat-1"), true);
    await mounted(fixture);
    await row(fixture, "node:n-concept").selection!.onChange(true);
    await fixture.flush();

    assert.match(inspector(fixture).textContent ?? "", /Missing native chat/);
    const tree = fixture.find("mountTree");
    const chatRow = (tree.props.rows as PluginTreeRow[])
      .flatMap((module) => module.children ?? [])
      .flatMap((node) => node.children ?? [])
      .find((entry) => entry.key === "chat:n-concept:chat-1");
    assert.ok(chatRow);
    const content = tree.treeContents.find((entry) => entry.key === "chat:n-concept:chat-1");
    assert.ok(content);
    assert.match(content.container.textContent ?? "", /\(missing\)/);

    await button(fixture, "Actions").props.onClick();
    const menu = fixture.find("openMenu");
    assert.equal(menu.props.label, "Session actions for First teaching chat");
    const unlink = menu.props.items.find((item: { key: string }) => item.key === "unlink");
    assert.ok(unlink);
    await unlink.onSelect();
    await fixture.flush();
    await fixture.flush();

    assert.equal(
      fixture.paths
        .get(path.id)!
        .modules.flatMap((module) => module.nodes)
        .find((node) => node.id === "n-concept")!
        .childSessions.length,
      0,
    );
    assert.doesNotMatch(inspector(fixture).textContent ?? "", /Missing native chat/);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("Link Existing Session offers only unlinked chats and attaches the chosen one", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    nativeChats: [{ id: "chat-free", title: "Free practice", kind: "practice" }],
  });
  try {
    await mounted(fixture);
    await row(fixture, "node:n-skill").selection!.onChange(true);
    await fixture.flush();

    await button(fixture, "Link Existing Session…").props.onClick();
    await fixture.flush();
    await fixture.flush();

    const dialog = fixture.find("openDialog");
    assert.equal(dialog.props.title, "Link Existing Session");
    const rows = dialog.contentContainer!.querySelectorAll(".lp-session-picker-row");
    assert.equal(rows.length, 1, "the already-linked chat-1 is not offered");
    assert.match(rows[0]!.textContent ?? "", /Free practice/);

    const link = fixture
      .all("mountButton")
      .find((record) => record.props.label === "Link");
    assert.ok(link);
    await link.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const linked = fixture.paths
      .get(path.id)!
      .modules.flatMap((module) => module.nodes)
      .find((node) => node.id === "n-skill")!
      .childSessions.find((entry) => entry.chatId === "chat-free");
    assert.ok(linked);
    assert.equal(linked.kind, "practice");
    assert.equal(dialog.disposed >= 1, true);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("a top-bar navigation target selects the parent node, before or after mount", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    requestPathHubTarget({ pathId: path.id, nodeId: "n-skill" });
    await mounted(fixture);
    assert.equal(inspector(fixture).dataset.nodeId, "n-skill");

    requestPathHubTarget({ pathId: path.id, nodeId: "n-contrast" });
    await fixture.flush();
    assert.equal(inspector(fixture).dataset.nodeId, "n-contrast");
    assert.equal(fixture.openedSessions.length, 0, "navigation does not open a native session");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});
