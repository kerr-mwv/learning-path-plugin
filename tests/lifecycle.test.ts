/** End-to-end lifecycle hardening tests.
 *
 * These cover the boundaries the earlier slices only exercised in isolation:
 * - backend and frontend enable → disable → re-enable are idempotent and keep
 *   learner data on disk;
 * - a late async result cannot write or paint after its view/settings scope has
 *   been unmounted;
 * - dialogs and menus never own keyboard/Escape, and closing them has no side
 *   effect (the host owns dismissal and focus);
 * - `install:local` updates only the packaged `dist/` and preserves the plugin's
 *   sibling `data/` directory, and the build/install scripts run warning-free.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { PluginMenuProps, PluginTreeRow, PluginView } from "learnharness-plugin-api";
import { activate as activateBackend } from "../src/backend.ts";
import { activate as activateFrontend } from "../src/main.ts";
import { mountPathHub } from "../src/view/path-hub.ts";
import { mountSettingsPage } from "../src/settings.ts";
import { SETTINGS_FILE } from "../src/store.ts";
import { makePath } from "./fixtures.ts";
import { createHost } from "./host.ts";
import { createViewFixture } from "./view-host.ts";
import type { ViewFixture } from "./view-host.ts";

const project = fileURLToPath(new URL("../", import.meta.url));

function temporaryDirectory(t: { after: (fn: () => void) => void }): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-lifecycle-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function runNode(script: string, args: readonly string[], cwd: string) {
  return spawnSync(process.execPath, [path.join(project, script), ...args], {
    cwd,
    encoding: "utf8",
  });
}

function buttonRecord(fixture: ViewFixture, label: string) {
  const found = fixture.all("mountButton").find((record) => record.props.label === label);
  assert.ok(found, `Missing button ${label}`);
  return found;
}

function selectedNode(fixture: ViewFixture, key: string) {
  const tree = fixture.find("mountTree");
  const rows: PluginTreeRow[] = [];
  const visit = (entries: readonly PluginTreeRow[]) => {
    for (const row of entries) {
      rows.push(row);
      if (row.children) visit(row.children);
    }
  };
  visit(tree.props.rows as readonly PluginTreeRow[]);
  const found = rows.find((row) => row.key === key);
  assert.ok(found, `Missing tree row ${key}`);
  return found;
}

async function flushAll(fixture: ViewFixture): Promise<void> {
  await fixture.flush();
  await fixture.flush();
}

test("backend enable, disable and re-enable are idempotent and keep stored data", async (t) => {
  const dataDirectory = temporaryDirectory(t);
  const host = createHost({ dataDirectory });
  t.after(() => host.close());

  const saved = await host.call<{ settings: { artifactDefaults: Record<string, string> } }>(
    "settings.save",
    {
      artifactDefaults: { concept: "derivation_trace" },
      architect: { followHostSlot: false, model: { provider: "test", id: "architect-model" } },
    },
  );
  assert.deepEqual(saved.settings.artifactDefaults, { concept: "derivation_trace" });
  const settingsBytes = fs.readFileSync(path.join(dataDirectory, SETTINGS_FILE), "utf8");

  // Disable twice: the second teardown must be a no-op, not a double-dispose.
  await host.cleanup();
  await host.cleanup();
  assert.equal(host.handlers.size, 0);
  assert.equal(host.definitions.size, 0);
  assert.equal(host.toolContributions.length, 0);
  assert.equal(host.instructions.length, 0);

  // Re-enable on the same (still live) activation context: every registration
  // comes back once and reads the same learner data from disk.
  activateBackend(host.ctx);
  assert.ok(host.handlers.size > 0);
  assert.ok(host.definitions.has("path-architect"));
  assert.equal(host.toolContributions.length, 1);
  assert.equal(host.instructions.length, 1);
  assert.deepEqual(await host.call("paths.status"), {
    id: "learning-path",
    version: "0.1.0",
    active: true,
  });
  assert.deepEqual(
    (await host.call<{ settings: { artifactDefaults: Record<string, string> } }>("settings.get"))
      .settings.artifactDefaults,
    { concept: "derivation_trace" },
  );
  assert.equal(
    fs.readFileSync(path.join(dataDirectory, SETTINGS_FILE), "utf8"),
    settingsBytes,
    "re-enable reads the store instead of rewriting it",
  );

  await host.cleanup();
  assert.equal(host.handlers.size, 0);
  assert.equal(host.definitions.size, 0);
});

test("frontend enable, disable and re-enable register one view and dispose its mounts", async (t) => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [],
  });
  t.after(() => fixture.restore());

  const dispose = activateFrontend(fixture.context);
  assert.equal(fixture.views.length, 1);
  assert.equal(fixture.views[0]!.id, "paths");
  assert.ok(fixture.toolRenderers.size > 0);
  assert.equal(fixture.settingsMounts.length, 1);

  const view = fixture.views[0]! as PluginView;
  const container = fixture.root.ownerDocument.createElement("div");
  fixture.root.append(container);
  const viewSignal = new AbortController();
  await view.mount(container, viewSignal.signal);
  await flushAll(fixture);
  assert.ok(container.querySelector(".lp-hub"), "the view mounts the Path Hub");

  viewSignal.abort();
  await flushAll(fixture);
  assert.equal(container.childElementCount, 0);
  assert.ok(
    fixture.records.every((record) => record.disposed >= 1),
    "unmount disposes every widget and tree-content mount",
  );

  // Disposing an activation twice must not throw or remove a later activation.
  dispose();
  dispose();
  assert.equal(fixture.views.length, 0);
  assert.equal(fixture.actions.length, 0);
  assert.equal(fixture.placements.length, 0);
  assert.equal(fixture.toolRenderers.size, 0);
  assert.equal(fixture.settingsMounts.length, 0);

  const disposeAgain = activateFrontend(fixture.context);
  assert.equal(fixture.views.length, 1);
  assert.equal(fixture.settingsMounts.length, 1);

  const settingsContainer = fixture.root.ownerDocument.createElement("div");
  fixture.root.append(settingsContainer);
  const settingsSignal = new AbortController();
  const cleanupSettings = await fixture.settingsMounts[0]!(settingsContainer, settingsSignal.signal);
  await flushAll(fixture);
  assert.match(settingsContainer.textContent ?? "", /Learning Paths/);

  settingsSignal.abort();
  if (typeof cleanupSettings === "function") cleanupSettings();
  await flushAll(fixture);
  assert.equal(settingsContainer.childElementCount, 0);
  disposeAgain();
  assert.equal(fixture.views.length, 0);
  assert.equal(fixture.settingsMounts.length, 0);
});

test("a late load after unmount cannot paint the Path Hub or refetch its path", async (t) => {
  const fixture = createViewFixture({ paths: [makePath()] });
  t.after(() => fixture.restore());

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = fixture.context.call.bind(fixture.context);
  fixture.context.call = (async (name: string, input?: unknown) => {
    if (name === "paths.list") await gate;
    return call(name, input);
  }) as typeof fixture.context.call;

  const controller = new AbortController();
  mountPathHub(fixture.context, fixture.root, controller.signal);
  controller.abort();
  release();
  await flushAll(fixture);

  assert.equal(fixture.root.childElementCount, 0, "the aborted mount leaves no DOM");
  assert.equal(
    fixture.calls.filter((entry) => entry.name === "paths.get").length,
    0,
    "a stale list response does not trigger a path read after abort",
  );
  assert.ok(fixture.records.every((record) => record.disposed >= 1));
});

test("a late settings read after unmount cannot render or save", async (t) => {
  const fixture = createViewFixture();
  t.after(() => fixture.restore());

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = fixture.context.call.bind(fixture.context);
  fixture.context.call = (async (name: string, input?: unknown) => {
    if (name === "settings.get") await gate;
    return call(name, input);
  }) as typeof fixture.context.call;

  const controller = new AbortController();
  const cleanup = mountSettingsPage(fixture.context, fixture.root, controller.signal);
  controller.abort();
  cleanup();
  release();
  await flushAll(fixture);

  assert.equal(fixture.root.childElementCount, 0, "the aborted settings mount leaves no DOM");
  assert.equal(
    fixture.calls.filter((entry) => entry.name === "settings.save").length,
    0,
    "a late read never turns into an accidental write",
  );
  assert.ok(fixture.records.every((record) => record.disposed >= 1));
});

test("dialogs and menus defer Escape and focus to the host and close without side effects", async (t) => {
  const fixture = createViewFixture({ paths: [makePath()] });
  t.after(() => fixture.restore());

  // The plugin must not register keyboard handlers: one physical Escape has one
  // owner, and that owner is the host's dialog/menu layer.
  const document = fixture.root.ownerDocument;
  const keyboardListeners: string[] = [];
  const add = document.addEventListener.bind(document);
  document.addEventListener = ((type: string, ...rest: unknown[]) => {
    if (/^key(down|up|press)$/.test(type)) keyboardListeners.push(type);
    return (add as (...args: unknown[]) => void)(type, ...rest);
  }) as typeof document.addEventListener;

  mountPathHub(fixture.context, fixture.root, fixture.context.signal);
  await flushAll(fixture);
  await selectedNode(fixture, "node:n-concept").selection!.onChange(true);
  await flushAll(fixture);

  // A modal dialog: accessible title, content scoped to its own signal.
  await buttonRecord(fixture, "Link Existing Session…").props.onClick();
  await flushAll(fixture);
  const dialog = fixture.find("openDialog");
  assert.equal(dialog.props.title, "Link Existing Session");
  assert.ok(dialog.props.title.trim().length > 0);
  assert.equal(dialog.signal, fixture.context.signal);

  const callsBeforeClose = fixture.calls.length;
  dialog.handle.dispose(); // host-owned close, as Escape would do
  await flushAll(fixture);
  assert.equal(
    fixture.calls.length,
    callsBeforeClose,
    "closing a dialog never attaches, deletes or saves anything by itself",
  );

  // An anchored menu: accessible label, stable item keys, no plugin keyboard work.
  await buttonRecord(fixture, "Actions").props.onClick();
  const menu = fixture.find("openMenu");
  const props = menu.props as PluginMenuProps;
  assert.equal(props.label, "Session actions for First teaching chat");
  assert.deepEqual(
    props.items.map((item) => item.key),
    ["open", "unlink"],
  );
  assert.equal(menu.signal, fixture.context.signal);

  const callsBeforeMenuClose = fixture.calls.length;
  menu.handle.dispose(); // host-owned Escape/outside-click close
  await flushAll(fixture);
  assert.equal(fixture.calls.length, callsBeforeMenuClose);
  assert.deepEqual(keyboardListeners, [], "the plugin relies on the host for Escape ownership");

  const sourceFiles = fs
    .readdirSync(path.join(project, "src"), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts"));
  for (const relative of sourceFiles) {
    const source = fs.readFileSync(path.join(project, "src", relative), "utf8");
    assert.doesNotMatch(
      source,
      /addEventListener\(\s*["']key(down|up|press)["']/,
      `${relative} must not own keyboard/Escape handling`,
    );
  }
});

test("install:local updates dist, preserves data and runs without warnings", (t) => {
  const workspace = temporaryDirectory(t);
  const pluginsDirectory = path.join(workspace, "plugins");
  fs.mkdirSync(pluginsDirectory);
  const installed = path.join(pluginsDirectory, "learning-path");
  const installedDist = path.join(installed, "dist");
  const installedData = path.join(installed, "data");

  const packageJson = JSON.parse(fs.readFileSync(path.join(project, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["install:local"], "npm run build && node scripts/install-plugin-local.mjs");

  const build = runNode("scripts/build.mjs", [], project);
  assert.equal(build.status, 0, build.stderr);
  assert.equal(build.stderr.trim(), "", "the production bundle emits no warnings");

  const first = runNode("scripts/install-plugin-local.mjs", [pluginsDirectory], project);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr.trim(), "");
  assert.ok(fs.existsSync(path.join(installedDist, "backend.cjs")));
  assert.ok(fs.existsSync(path.join(installedDist, "main.js")));
  assert.ok(fs.existsSync(path.join(installedDist, "manifest.json")));
  assert.ok(fs.existsSync(path.join(installedDist, "styles.css")));

  // A host keeps learner data beside dist/, inside the plugin directory.
  fs.mkdirSync(path.join(installedData, "sources"), { recursive: true });
  const pathsBytes = '{"version":1,"paths":[]}';
  const sourceBytes = "# preserved source";
  fs.writeFileSync(path.join(installedData, "learning-paths.json"), pathsBytes);
  fs.writeFileSync(path.join(installedData, "sources", "learned.md"), sourceBytes);

  // Simulate the next build: overwrite the installed code, then reinstall.
  fs.writeFileSync(path.join(installedDist, "main.js"), "// stale build");
  const rebuild = runNode("scripts/build.mjs", [], project);
  assert.equal(rebuild.status, 0, rebuild.stderr);
  assert.equal(rebuild.stderr.trim(), "");
  const second = runNode("scripts/install-plugin-local.mjs", [pluginsDirectory], project);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr.trim(), "");

  assert.equal(
    fs.readFileSync(path.join(installedDist, "main.js"), "utf8"),
    fs.readFileSync(path.join(project, "dist", "main.js"), "utf8"),
    "the update replaced the stale packaged code",
  );
  assert.equal(fs.readFileSync(path.join(installedData, "learning-paths.json"), "utf8"), pathsBytes);
  assert.equal(fs.readFileSync(path.join(installedData, "sources", "learned.md"), "utf8"), sourceBytes);
});

test("install:local refuses a package that contains a data directory", (t) => {
  const workspace = temporaryDirectory(t);
  const source = path.join(workspace, "source");
  const plugins = path.join(workspace, "plugins");
  fs.mkdirSync(path.join(source, "dist", "data"), { recursive: true });
  fs.mkdirSync(plugins);
  fs.writeFileSync(
    path.join(source, "dist", "manifest.json"),
    JSON.stringify({ apiVersion: 1, id: "learning-path", name: "Learning Paths", version: "0.1.0", minAppVersion: "0.6.0", main: "main.js" }),
  );
  fs.writeFileSync(path.join(source, "dist", "main.js"), "export {};");
  fs.writeFileSync(path.join(source, "dist", "data", "learning-paths.json"), '{"keep":true}');

  const result = runNode("scripts/install-plugin-local.mjs", [plugins], source);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non-distributable package entry/);
  assert.equal(
    fs.readFileSync(path.join(source, "dist", "data", "learning-paths.json"), "utf8"),
    '{"keep":true}',
    "the refused package is left untouched",
  );
  assert.equal(fs.existsSync(path.join(plugins, "learning-path")), false);
});
