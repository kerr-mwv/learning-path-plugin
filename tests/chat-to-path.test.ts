import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginActionContext } from "learnharness-plugin-api";
import { CHAT_PATH_ARCHITECT_ID, CHAT_PATH_FOLLOW_UP } from "../src/chat-to-path.ts";
import { registerSessionActions } from "../src/session-actions.ts";
import { clearPathHubTarget, consumePathHubTarget, requestPathHubDraft } from "../src/session-navigation.ts";
import type { ChatPathPreview } from "../src/session-types.ts";
import { EVENT_ARCHITECT_CHANGED } from "../src/topics.ts";
import { mountPathHub } from "../src/view/path-hub.ts";
import { makePath } from "./fixtures.ts";
import { createHost } from "./host.ts";
import { createViewFixture, fire, makeConversation } from "./view-host.ts";

const chat = {
  id: "review-chat", title: "Teaching about page tables", kind: "teach" as const,
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", messages: [],
};
const settings = { artifactDefaults: {}, chatToPathEnabled: true };
const proposal = makePath();

function attachContext(kind: "teaching" | "practice"): PluginActionContext {
  return { placement: "top-bar", surface: "session", sessionId: chat.id, kind, surfaceTarget: {} as never, view: {} as never };
}

test("unified Learning Path action keeps create disabled until a ready unlinked Teaching chat", async () => {
  const fixture = createViewFixture({ settings: { artifactDefaults: {}, chatToPathEnabled: true } });
  const backend = createHost({ chats: [chat] });
  try {
    const originalCall = fixture.context.call.bind(fixture.context);
    fixture.context.call = (name, input) => name === "sessions.toPathPreview"
      ? backend.call(name, input) : originalCall(name, input);
    registerSessionActions(fixture.context);
    const action = fixture.actions.find((entry) => entry.id === "lp-learning-path")!;
    const view = { busy: false, status: "ready" as const, phase: "teach" as const };
    const open = async (kind: "teaching" | "practice", nextView: { busy: boolean; status: "ready"; phase: "teach" | "plan" } = view) => {
      await action.run({ placement: "top-bar", surface: "session", sessionId: chat.id, kind, surfaceTarget: {} as never, view: nextView as never });
      await fixture.flush();
    };
    const button = (label: string) => fixture.all("mountButton").findLast((entry) => !entry.disposed && entry.props.label === label);

    await open("practice");
    assert.equal(button("Create a Path from This Lesson…")!.props.disabled, true);
    fixture.findLast("openDialog", (entry) => !entry.disposed).handle.dispose();
    await open("teaching", { ...view, phase: "plan" });
    assert.equal(button("Create a Path from This Lesson…")!.props.disabled, true);
    fixture.findLast("openDialog", (entry) => !entry.disposed).handle.dispose();
    await open("teaching");
    assert.equal(button("Create a Path from This Lesson…")!.props.disabled, false);
    await button("Create a Path from This Lesson…")!.props.onClick();
    await fixture.flush();
    assert.equal(fixture.findLast("openDialog", (entry) => !entry.disposed).props.title, "Create a Learning Path from This Chat");
    assert.equal(consumePathHubTarget(), null);
  } finally {
    clearPathHubTarget();
    fixture.restore();
    backend.close();
  }
});

test("unified Learning Path action greys out create for an already-linked session", async () => {
  const fixture = createViewFixture({ paths: [makePath()], settings });
  try {
    registerSessionActions(fixture.context);
    const action = fixture.actions.find((entry) => entry.id === "lp-learning-path")!;
    await action.run({ placement: "top-bar", surface: "session", sessionId: "chat-1", kind: "teaching", surfaceTarget: {} as never, view: { busy: false, status: "ready", phase: "teach" } as never });
    await fixture.flush();
    const create = fixture.all("mountButton").findLast((entry) => entry.props.label === "Create a Path from This Lesson…");
    assert.equal(create?.props.disabled, true);
    assert.match(fixture.root.textContent ?? "", /already linked/);
  } finally {
    fixture.restore();
  }
});

test("preview RPC is bounded and only returns the reviewed fields", async () => {
  const backend = createHost({ chats: [{ ...chat, title: "t".repeat(9_000), tree: {
    version: 1, nodes: Array.from({ length: 25 }, (_, index) => ({ id: String(index), title: "z".repeat(10_000), summary: "not imported" })), edges: [],
  } }] });
  try {
    await assert.rejects(backend.call("sessions.toPathPreview", { chatId: chat.id }), /disabled/);
    await backend.call("settings.save", settings);
    const result = await backend.call<ChatPathPreview>("sessions.toPathPreview", { chatId: chat.id });
    assert.deepEqual(Object.keys(result).sort(), ["busy", "outline", "revision", "title", "truncated"]);
    assert.equal(result.outline?.length, 2_000);
    assert.equal(result.title.length, 200);
    assert.equal(result.truncated, true);
    backend.removeChat(chat.id);
    await assert.rejects(backend.call("sessions.toPathPreview", { chatId: chat.id }), /no longer exists/);
  } finally {
    backend.close();
  }
});

test("warm hub preserves the reviewed seed instead of reusing the already-loaded Architect", async () => {
  const path = { ...proposal, architectChatId: "loaded" };
  const fixture = createViewFixture({ paths: [path], conversations: [makeConversation("loaded")] });
  try {
    const unmount = mountPathHub(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();
    assert.ok(fixture.calls.some((entry) => entry.name === "architect.get"));
    requestPathHubDraft("Reviewed teaching background");
    assert.equal(fixture.find("mountStandardComposer").props.composer.value, "Reviewed teaching background");
    assert.equal(fixture.root.querySelector<HTMLElement>(".lp-architect")?.closest<HTMLElement>("[hidden]"), null);
    assert.ok(!fixture.calls.some((entry) => entry.name === "architect.create" || entry.name === "architect.send"));
    unmount();
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("a busy Architect is not replaced or sent the reviewed background", async () => {
  const fixture = createViewFixture({
    paths: [{ ...proposal, architectChatId: "running" }],
    conversations: [makeConversation("running", { status: "running" })],
  });
  try {
    const unmount = mountPathHub(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();
    requestPathHubDraft("Reviewed background");
    assert.match(fixture.root.textContent ?? "", /Architect is busy.*reopen the Teaching-chat review/);
    assert.equal(fixture.find("mountStandardComposer").props.composer.busy, true);
    assert.equal(fixture.find("mountStandardComposer").props.composer.value, "");
    assert.ok(!fixture.calls.some((entry) => entry.name === "architect.create" || entry.name === "architect.send"));
    unmount();
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("chat-origin tools stage only; follow-up and an explicit approval of the displayed proposal precede the write", async () => {
  const backend = createHost({ chats: [chat] });
  const fixture = createViewFixture({ settings });
  try {
    await backend.call("settings.save", settings);
    const call = fixture.context.call.bind(fixture.context);
    fixture.context.call = (name, input) => name.startsWith("architect.") ? backend.call(name, input) : call(name, input);
    const unmount = mountPathHub(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();
    requestPathHubDraft("Approved Teaching-chat background");
    const composer = () => fixture.find("mountStandardComposer").props.composer;
    const paths = async () => (await backend.call<{ paths: unknown[] }>("paths.list")).paths;
    assert.equal(backend.records.size, 0);
    composer().onSend();
    await fixture.flush();
    const record = [...backend.records.values()][0]!;
    assert.equal(record.definitionId, CHAT_PATH_ARCHITECT_ID);
    const pathTools = backend.definitions.get(record.definitionId)?.tools ?? [];
    assert.match(backend.definitions.get(record.definitionId)!.instructions, /first reply/);
    const stage = async (suffix: "" | "_json", toolCallId: string) => {
      const name = `save_learning_path${suffix}`;
      const tool = pathTools.find((candidate) => candidate.name === name)!;
      assert.ok(tool.execute);
      const result = await tool.execute(toolCallId, suffix ? { draftJson: JSON.stringify(proposal) } : proposal, backend.controller.signal);
      assert.ok(!result.isError);
      record.messages.push({ role: "toolResult", toolName: name, toolCallId, isError: false, ...result, timestamp: Date.now() });
      record.status = "idle";
      fixture.emit(EVENT_ARCHITECT_CHANGED, { id: record.id, messageCount: record.messages.length });
      await fixture.flush();
      assert.deepEqual(await paths(), []);
    };
    await stage("", "too-early");
    await assert.rejects(backend.call("architect.approveChatPath", { id: record.id, toolCallId: "too-early" }), /No current/);
    assert.match(fixture.root.textContent ?? "", new RegExp(CHAT_PATH_FOLLOW_UP.slice(0, 30), "i"));
    composer().onChange("I would like to study linear algebra next.");
    composer().onSend();
    await fixture.flush();
    await stage("_json", "displayed-proposal");
    assert.match(fixture.root.textContent ?? "", /Review proposed path: Linear algebra from canon/);
    await assert.rejects(backend.call("architect.approveChatPath", { id: record.id, toolCallId: "too-early" }), /No current/);
    const save = fixture.findLast("mountButton", (entry) => !entry.disposed && entry.props.label === "Approve and Save Path");
    await save.props.onClick();
    const result = await backend.call<{ path: typeof proposal }>("paths.get", { id: proposal.id });
    assert.equal(result.path.architectChatId, record.id);
    assert.equal((await paths()).length, 1);
    assert.ok(result.path.modules.flatMap((module) => module.nodes).every((node) => node.progression === "unstarted" && node.childSessions.length === 0));
    assert.deepEqual(backend.chats.get(chat.id), chat);
    unmount();
  } finally {
    clearPathHubTarget();
    fixture.restore();
    backend.close();
  }
});
