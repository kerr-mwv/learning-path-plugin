/** Session top-bar action tests for the unified Learning Path menu. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginActionContext } from "learnharness-plugin-api";
import { registerSessionActions } from "../src/session-actions.ts";
import { clearPathHubTarget, subscribePathHubTarget } from "../src/session-navigation.ts";
import type { PathHubTarget } from "../src/session-navigation.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture, fire } from "./view-host.ts";
import type { ViewFixture } from "./view-host.ts";

type SessionView = Extract<PluginActionContext, { surface: "session" }>["view"];

function sessionContext(
  sessionId: string,
  kind: "teaching" | "practice",
  view: Partial<SessionView> = {},
): PluginActionContext {
  return {
    placement: "top-bar",
    surface: "session",
    sessionId,
    kind,
    surfaceTarget: {} as never,
    view: {
      busy: false,
      status: "ready",
      phase: "teach",
      ...view,
    } as SessionView,
  };
}

function action(fixture: ViewFixture, id: string) {
  const found = fixture.actions.find((candidate) => candidate.id === id);
  assert.ok(found, `Missing action ${id}; have ${fixture.actions.map((entry) => entry.id).join(", ")}`);
  return found;
}

function button(fixture: ViewFixture, label: string) {
  const found = fixture.findLast("mountButton", (record) => record.props.label === label);
  assert.ok(found, `Missing button ${label}`);
  return found;
}

async function openMenu(
  fixture: ViewFixture,
  sessionId: string,
  kind: "teaching" | "practice",
  view: Partial<SessionView> = {},
): Promise<void> {
  await action(fixture, "lp-learning-path").run(sessionContext(sessionId, kind, view));
  await fixture.flush();
}

test("registers one unified Learning Path action and top-bar placement", () => {
  const fixture = createViewFixture({ paths: [makePath()] });
  try {
    const dispose = registerSessionActions(fixture.context);
    assert.deepEqual(fixture.actions.map((entry) => [entry.id, entry.name]), [["lp-learning-path", "Learning Path"]]);
    assert.deepEqual(fixture.placements, [{
      id: "lp-learning-path-top-bar",
      actionId: "lp-learning-path",
      location: "top-bar",
      sessions: ["teaching", "practice"],
    }]);
    dispose();
    assert.equal(fixture.actions.length, 0);
    assert.equal(fixture.placements.length, 0);
  } finally {
    fixture.restore();
  }
});

test("menu parent choice targets the linked node and opens the hub", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    registerSessionActions(fixture.context);
    const targets: PathHubTarget[] = [];
    const off = subscribePathHubTarget((target) => targets.push(target));
    await openMenu(fixture, "chat-1", "teaching");
    await button(fixture, "Open Parent Learning Path").props.onClick();
    await fixture.flush();
    off();
    assert.deepEqual(targets, [{ kind: "node", pathId: path.id, nodeId: "n-concept" }]);
    assert.deepEqual(fixture.openedViews, ["paths"]);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("menu preserves ordinary attachment", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    nativeChats: [{ id: "chat-free", title: "Free practice", kind: "practice" }],
  });
  try {
    registerSessionActions(fixture.context);
    await openMenu(fixture, "chat-free", "practice");
    await button(fixture, "Attach Session to Path…").props.onClick();
    await fixture.flush();
    await fixture.flush();
    const dialog = fixture.findLast("openDialog", (record) => record.props.title === "Attach Session to Path");
    const [pathSelect, nodeSelect] = dialog.contentContainer!.querySelectorAll("select");
    assert.equal(pathSelect?.options.length, 1);
    const nodeOption = [...(nodeSelect?.options ?? [])].find((option) => option.value === "n-skill");
    assert.ok(nodeOption);
    for (const option of nodeSelect!.options) option.selected = false;
    nodeOption.selected = true;
    fire(nodeSelect!, "change");
    await fixture.flush();
    await button(fixture, "Attach Session").props.onClick();
    await fixture.flush();
    const linked = fixture.paths.get(path.id)!.modules.flatMap((module) => module.nodes)
      .find((node) => node.id === "n-skill")!.childSessions.find((entry) => entry.chatId === "chat-free");
    assert.ok(linked);
    assert.equal(linked.kind, "practice");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("create choice is enabled only for a likely-ready unlinked teaching lesson", async () => {
  const fixture = createViewFixture({ settings: { artifactDefaults: {}, chatToPathEnabled: true } });
  try {
    registerSessionActions(fixture.context);
    await openMenu(fixture, "chat-free", "teaching");
    assert.equal(button(fixture, "Create a Path from This Lesson…").props.disabled, false);
  } finally {
    fixture.restore();
  }
});

test("create choice is disabled when linked, not ready, or setting-off", async () => {
  const linkedFixture = createViewFixture({ paths: [makePath()], settings: { artifactDefaults: {}, chatToPathEnabled: true } });
  try {
    registerSessionActions(linkedFixture.context);
    await openMenu(linkedFixture, "chat-1", "teaching");
    assert.equal(button(linkedFixture, "Create a Path from This Lesson…").props.disabled, true);
  } finally {
    linkedFixture.restore();
  }

  const notReadyFixture = createViewFixture({ settings: { artifactDefaults: {}, chatToPathEnabled: true } });
  try {
    registerSessionActions(notReadyFixture.context);
    await openMenu(notReadyFixture, "chat-free", "teaching", { phase: "plan" });
    assert.equal(button(notReadyFixture, "Create a Path from This Lesson…").props.disabled, true);
  } finally {
    notReadyFixture.restore();
  }

  const disabledFixture = createViewFixture();
  try {
    registerSessionActions(disabledFixture.context);
    await openMenu(disabledFixture, "chat-free", "teaching");
    assert.equal(button(disabledFixture, "Create a Path from This Lesson…").props.disabled, true);
  } finally {
    disabledFixture.restore();
  }
});

test("an already-linked session remains informational in the attach dialog", async () => {
  const fixture = createViewFixture({ paths: [makePath()] });
  try {
    registerSessionActions(fixture.context);
    await openMenu(fixture, "chat-1", "teaching");
    await button(fixture, "Attach Session to Path…").props.onClick();
    await fixture.flush();
    await fixture.flush();
    const dialog = fixture.findLast("openDialog", (record) => record.props.title === "Attach Session to Path");
    assert.match(dialog.contentContainer!.textContent ?? "", /already linked to "Node n-concept"/);
    assert.equal(dialog.contentContainer!.querySelectorAll("select").length, 0);
    assert.equal(fixture.calls.some((call) => call.name === "sessions.link"), false);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});
