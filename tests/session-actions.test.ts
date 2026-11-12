/** Session top-bar action tests.
 *
 * Asserts the two explicit placements, that "Open Parent Learning Path" resolves
 * the native chat to its node and navigates to the Path Hub, and that "Attach
 * Session to Path…" links the current chat only after an explicit confirmation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginActionContext, PluginActionPlacement } from "learnharness-plugin-api";
import { registerSessionActions } from "../src/session-actions.ts";
import {
  clearPathHubTarget,
  subscribePathHubTarget,
} from "../src/session-navigation.ts";
import type { PathHubTarget } from "../src/session-navigation.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture, fire } from "./view-host.ts";
import type { ViewFixture } from "./view-host.ts";

function sessionContext(sessionId: string, kind: "teaching" | "practice"): PluginActionContext {
  return {
    placement: "top-bar",
    surface: "session",
    sessionId,
    kind,
    surfaceTarget: {} as never,
    view: {} as never,
  };
}

function action(fixture: ViewFixture, id: string) {
  const found = fixture.actions.find((candidate) => candidate.id === id);
  assert.ok(found, `Missing action ${id}; have ${fixture.actions.map((entry) => entry.id).join(", ")}`);
  return found;
}

function placement(fixture: ViewFixture, actionId: string): PluginActionPlacement {
  const found = fixture.placements.find(
    (candidate) => candidate.actionId === actionId,
  );
  assert.ok(found, `Missing placement for ${actionId}`);
  return found;
}

test("registers both actions and explicit top-bar placements for teaching and practice", () => {
  const fixture = createViewFixture({ paths: [makePath()] });
  try {
    const dispose = registerSessionActions(fixture.context);
    assert.deepEqual(
      fixture.actions.map((entry) => [entry.id, entry.name]),
      [
        ["lp-open-parent-learning-path", "Open Parent Learning Path"],
        ["lp-attach-session-to-path", "Attach Session to Path…"],
      ],
    );
    assert.deepEqual(placement(fixture, "lp-open-parent-learning-path"), {
      id: "lp-open-parent-top-bar",
      actionId: "lp-open-parent-learning-path",
      location: "top-bar",
      sessions: ["teaching", "practice"],
    });
    assert.deepEqual(placement(fixture, "lp-attach-session-to-path"), {
      id: "lp-attach-session-top-bar",
      actionId: "lp-attach-session-to-path",
      location: "top-bar",
      sessions: ["teaching", "practice"],
    });
    dispose();
    assert.equal(fixture.actions.length, 0);
    assert.equal(fixture.placements.length, 0);
  } finally {
    fixture.restore();
  }
});

test("Open Parent Learning Path targets the linked node and opens the hub", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    registerSessionActions(fixture.context);
    const targets: PathHubTarget[] = [];
    const off = subscribePathHubTarget((target) => targets.push(target));
    try {
      await action(fixture, "lp-open-parent-learning-path").run(sessionContext("chat-1", "teaching"));
    } finally {
      off();
    }
    assert.deepEqual(targets, [{ pathId: path.id, nodeId: "n-concept" }]);
    assert.deepEqual(fixture.openedViews, ["paths"]);

    // An unlinked chat still opens the hub; it just has no node to preselect.
    await action(fixture, "lp-open-parent-learning-path").run(sessionContext("chat-free", "practice"));
    assert.equal(targets.length, 1);
    assert.deepEqual(fixture.openedViews, ["paths", "paths"]);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("Attach Session to Path links the current chat after choosing a node", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    nativeChats: [{ id: "chat-free", title: "Free practice", kind: "practice" }],
  });
  try {
    registerSessionActions(fixture.context);
    await action(fixture, "lp-attach-session-to-path").run(sessionContext("chat-free", "practice"));
    await fixture.flush();
    await fixture.flush();

    const dialog = fixture.find("openDialog");
    assert.equal(dialog.props.title, "Attach Session to Path");
    const content = dialog.contentContainer!;
    const selects = content.querySelectorAll("select");
    assert.equal(selects.length, 2, "path and node selectors");
    const [pathSelect, nodeSelect] = selects;
    assert.ok(pathSelect && nodeSelect);
    assert.equal(pathSelect.options.length, 1);
    assert.equal(pathSelect.options[0]!.value, path.id);
    const nodeOption = [...nodeSelect.options].find((option) => option.value === "n-skill");
    assert.ok(nodeOption, "every node is offered");
    for (const option of nodeSelect.options) option.selected = false;
    nodeOption.selected = true;
    fire(nodeSelect, "change");
    await fixture.flush();

    const attach = fixture
      .all("mountButton")
      .find((record) => record.props.label === "Attach Session");
    assert.ok(attach, "the dialog exposes an explicit Attach Session button");
    await attach.props.onClick();
    await fixture.flush();

    const linked = fixture.paths
      .get(path.id)!
      .modules.flatMap((module) => module.nodes)
      .find((node) => node.id === "n-skill")!
      .childSessions.find((entry) => entry.chatId === "chat-free");
    assert.ok(linked);
    assert.equal(linked.kind, "practice");
    assert.equal(dialog.disposed >= 1, true, "a successful attach closes the dialog");
    assert.equal(fixture.openedSessions.length, 0, "attaching does not navigate away");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("an already-linked session is reported instead of offering a second link", async () => {
  const fixture = createViewFixture({ paths: [makePath()] });
  try {
    registerSessionActions(fixture.context);
    await action(fixture, "lp-attach-session-to-path").run(sessionContext("chat-1", "teaching"));
    await fixture.flush();
    await fixture.flush();
    const dialog = fixture.find("openDialog");
    assert.match(
      dialog.contentContainer!.textContent ?? "",
      /already linked to "Node n-concept" in "Linear algebra from canon"/,
    );
    assert.equal(dialog.contentContainer!.querySelectorAll("select").length, 0);
    assert.equal(
      fixture.calls.some((call) => call.name === "sessions.link"),
      false,
      "no write happens from the informational dialog",
    );
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});
