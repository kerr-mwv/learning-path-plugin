/** Atomic, versioned persistence under ctx.dataDirectory. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DomainValidationError } from "../src/domain.ts";
import {
  ARCHITECT_FILE,
  LEARNING_PATHS_BACKUP_FILE,
  LEARNING_PATHS_FILE,
  PATHS_DIRECTORY,
  SETTINGS_FILE,
  SOURCES_DIRECTORY,
  SOURCE_INDEX_FILE,
  STORE_SCHEMA_VERSION,
  StoreError,
  WORKSPACES_DIRECTORY,
  WORKSPACE_FILES_DIRECTORY,
  WORKSPACE_MANIFEST_FILE,
  openLearningPathStore,
} from "../src/store.ts";
import { AT, ITEM_ID, clone, makePath } from "./fixtures.ts";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function directory(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const read = (dir: string, name: string): string => fs.readFileSync(path.join(dir, name), "utf8");
const write = (dir: string, name: string, content: string): void =>
  fs.writeFileSync(path.join(dir, name), content);
const pathFile = (id: string): string => path.join(PATHS_DIRECTORY, `${id}.json`);
const readPathEnvelope = (dir: string, id: string): any => JSON.parse(read(dir, pathFile(id)));
const temporaryFiles = (dir: string): string[] =>
  fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));
const pathsTemporaryFiles = (dir: string): string[] =>
  fs.existsSync(path.join(dir, PATHS_DIRECTORY))
    ? fs.readdirSync(path.join(dir, PATHS_DIRECTORY)).filter((name) => name.endsWith(".tmp"))
    : [];

test("saves, replaces and reloads paths with one versioned file per path", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  assert.deepEqual(store.paths(), []);
  assert.equal(store.path("path-linear-algebra"), null);
  assert.deepEqual(store.settings(), { artifactDefaults: {} });

  const saved = store.savePath(makePath());
  assert.deepEqual(saved, makePath());
  const envelope = readPathEnvelope(dir, "path-linear-algebra");
  assert.equal(envelope.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(envelope.revision, 1);
  assert.deepEqual(envelope.path, makePath());

  const linearBefore = read(dir, pathFile("path-linear-algebra"));
  const second = { ...clone(makePath()), id: "path-2", title: "Second path" };
  store.savePath(second);
  const secondEnvelope = readPathEnvelope(dir, "path-2");
  assert.equal(secondEnvelope.revision, 1);
  assert.deepEqual(secondEnvelope.path, second);
  assert.equal(
    read(dir, pathFile("path-linear-algebra")),
    linearBefore,
    "saving another path does not rewrite this one",
  );

  store.savePath({ ...makePath(), title: "Renamed in place" });
  const renamed = readPathEnvelope(dir, "path-linear-algebra");
  assert.equal(renamed.revision, 2);
  assert.equal(renamed.path.title, "Renamed in place");
  assert.equal(readPathEnvelope(dir, "path-2").revision, 1);

  const reopened = openLearningPathStore(dir);
  assert.equal(reopened.paths().length, 2);
  assert.equal(reopened.path("path-linear-algebra")?.title, "Renamed in place");
  assert.equal(readPathEnvelope(dir, "path-linear-algebra").revision, 2);

  const linearAfterRename = read(dir, pathFile("path-linear-algebra"));
  assert.equal(reopened.deletePath("path-missing"), false);
  assert.equal(reopened.deletePath("path-2"), true);
  assert.equal(reopened.paths().length, 1);
  assert.equal(fs.existsSync(path.join(dir, pathFile("path-2"))), false);
  assert.equal(read(dir, pathFile("path-linear-algebra")), linearAfterRename);
  assert.equal(openLearningPathStore(dir).path("path-2"), null);
});

test("a failed atomic rename keeps memory, previous bytes and no temporary file", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const before = read(dir, pathFile("path-linear-algebra"));
  const beforePaths = clone(store.paths());

  t.mock.method(fs, "renameSync", () => {
    throw new Error("Synthetic rename failure");
  });
  assert.throws(() => store.savePath({ ...makePath(), title: "Never persisted" }), /Synthetic rename failure/);

  assert.deepEqual(store.paths(), beforePaths);
  assert.equal(read(dir, pathFile("path-linear-algebra")), before);
  assert.deepEqual(pathsTemporaryFiles(dir), []);
  assert.deepEqual(openLearningPathStore(dir).paths(), beforePaths);
});

test("refuses corrupt JSON and invalid path records without changing a byte", (t) => {
  const cases = [
    { name: "path-linear-algebra.json", content: "{ not json" },
    {
      name: "path-linear-algebra.json",
      content: JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision: 0, path: { ...makePath(), modules: "nope" } }),
    },
    {
      name: "wrong-filename.json",
      content: JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision: 0, path: makePath() }),
    },
    {
      name: "path-linear-algebra.json",
      content: JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision: -1, path: makePath() }),
    },
    {
      name: "path-linear-algebra.json",
      content: JSON.stringify({ schemaVersion: 0, revision: 0, path: makePath() }),
    },
  ];
  for (const { name, content } of cases) {
    const dir = directory(t);
    fs.mkdirSync(path.join(dir, PATHS_DIRECTORY), { recursive: true });
    write(dir, path.join(PATHS_DIRECTORY, name), content);
    assert.throws(
      () => openLearningPathStore(dir),
      (error: unknown) => error instanceof StoreError && /corrupt/.test(error.message),
      `accepted corrupt content: ${content}`,
    );
    assert.equal(read(dir, path.join(PATHS_DIRECTORY, name)), content);
  }
});

test("refuses a newer path schema version instead of wiping learner data", (t) => {
  const dir = directory(t);
  const content = JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION + 1, revision: 9, path: makePath() });
  fs.mkdirSync(path.join(dir, PATHS_DIRECTORY), { recursive: true });
  write(dir, pathFile("path-linear-algebra"), content);
  assert.throws(
    () => openLearningPathStore(dir),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "newer-schema" &&
      /newer schema version 2/.test(error.message) &&
      /No data was changed/.test(error.message),
  );
  assert.equal(read(dir, pathFile("path-linear-algebra")), content);

  for (const name of [SETTINGS_FILE]) {
    const settingsDir = directory(t);
    write(settingsDir, name, JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION + 1, revision: 0, settings: {} }));
    assert.throws(() => openLearningPathStore(settingsDir), /newer schema version/);
  }
});

test("refuses invalid settings records and invalid saves without writing", (t) => {
  const dir = directory(t);
  const content = JSON.stringify({
    schemaVersion: STORE_SCHEMA_VERSION,
    revision: 0,
    settings: { artifactDefaults: { lecture: "micro_code" } },
  });
  write(dir, SETTINGS_FILE, content);
  assert.throws(() => openLearningPathStore(dir), /corrupt: invalid settings/);
  assert.equal(read(dir, SETTINGS_FILE), content);

  const clean = directory(t);
  const store = openLearningPathStore(clean);
  assert.throws(() => store.savePath({ ...makePath(), id: "Bad Id" }), DomainValidationError);
  assert.throws(
    () => store.savePath({ ...makePath(), id: "path..escape" }),
    (error: unknown) => error instanceof StoreError && error.code === "unsafe",
  );
  assert.equal(fs.existsSync(path.join(clean, PATHS_DIRECTORY)), false);
  assert.equal(fs.existsSync(path.join(clean, LEARNING_PATHS_FILE)), false);
  assert.throws(
    () => store.saveSettings({ artifactDefaults: { concept: "video" } } as never),
    DomainValidationError,
  );
  assert.equal(fs.existsSync(path.join(clean, SETTINGS_FILE)), false);
});

test("settings round-trip atomically through their own versioned file", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  const saved = store.saveSettings({ artifactDefaults: { contrast: "relational_map", bridge: "none" } });
  assert.deepEqual(saved, { artifactDefaults: { contrast: "relational_map", bridge: "none" } });
  const envelope = JSON.parse(read(dir, SETTINGS_FILE));
  assert.equal(envelope.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(envelope.revision, 1);
  assert.deepEqual(openLearningPathStore(dir).settings(), saved);
});

test("converted sources use UUID-only private paths and ignore foreign files", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  const markdown = "# Converted Markdown\n\nA supported fact.";

  assert.equal(store.readSource(UUID), null);
  store.writeSource(UUID, markdown);
  assert.equal(store.readSource(UUID), markdown);
  assert.deepEqual(store.listSourceIds(), [UUID]);
  assert.equal(fs.statSync(path.join(dir, SOURCES_DIRECTORY, `${UUID}.md`)).mode & 0o077, 0);
  assert.equal(fs.statSync(path.join(dir, SOURCES_DIRECTORY)).mode & 0o077, 0);

  write(dir, path.join(SOURCES_DIRECTORY, "notes.md"), "not a managed source");
  write(dir, path.join(SOURCES_DIRECTORY, "not-a-uuid.md"), "not a managed source");
  write(dir, path.join(SOURCES_DIRECTORY, `${UUID}.tmp`), "leftover");
  assert.deepEqual(store.listSourceIds(), [UUID]);
  assert.equal(fs.existsSync(path.join(dir, SOURCES_DIRECTORY, "notes.md")), true);

  for (const unsafe of ["../outside", "/tmp/outside", "notes.md", "", null]) {
    assert.throws(() => store.writeSource(unsafe as never, markdown), /Invalid source ID/);
    assert.throws(() => store.readSource(unsafe as never), /Invalid source ID/);
    assert.throws(() => store.removeSource(unsafe as never), /Invalid source ID/);
  }

  assert.equal(openLearningPathStore(dir).readSource(UUID), markdown);
  store.removeSource(UUID);
  store.removeSource(UUID);
  assert.equal(store.readSource(UUID), null);
});

test("refuses symlinked managed files and directories instead of following them outside the store", (t) => {
  const legacyDir = directory(t);
  const outsideLegacy = path.join(legacyDir, "outside.json");
  write(legacyDir, "outside.json", JSON.stringify({ keep: true }));
  fs.symlinkSync(outsideLegacy, path.join(legacyDir, LEARNING_PATHS_FILE));
  assert.throws(() => openLearningPathStore(legacyDir), /symlinked/);
  assert.equal(read(legacyDir, "outside.json"), JSON.stringify({ keep: true }));

  const pathsDir = directory(t);
  const outsidePaths = path.join(pathsDir, "outside-paths");
  fs.mkdirSync(outsidePaths);
  write(pathsDir, path.join("outside-paths", "path-linear-algebra.json"), "outside");
  fs.symlinkSync(outsidePaths, path.join(pathsDir, PATHS_DIRECTORY));
  assert.throws(() => openLearningPathStore(pathsDir), /symlinked Learning Path directory/);
  assert.equal(read(pathsDir, path.join("outside-paths", "path-linear-algebra.json")), "outside");

  const pathFileDir = directory(t);
  const outsidePath = path.join(pathFileDir, "outside.json");
  write(pathFileDir, "outside.json", JSON.stringify({ keep: true }));
  fs.mkdirSync(path.join(pathFileDir, PATHS_DIRECTORY));
  fs.symlinkSync(outsidePath, path.join(pathFileDir, pathFile("path-linear-algebra")));
  assert.throws(() => openLearningPathStore(pathFileDir), /symlinked/);
  assert.equal(read(pathFileDir, "outside.json"), JSON.stringify({ keep: true }));

  const sourceDir = directory(t);
  const store = openLearningPathStore(sourceDir);
  fs.mkdirSync(path.join(sourceDir, SOURCES_DIRECTORY), { recursive: true });
  const outsideSource = path.join(sourceDir, "outside.md");
  fs.writeFileSync(outsideSource, "outside");
  fs.symlinkSync(outsideSource, path.join(sourceDir, SOURCES_DIRECTORY, `${UUID}.md`));
  assert.throws(() => store.readSource(UUID), /symlinked source file/);
  assert.throws(() => store.writeSource(UUID, "replacement"), /Refusing to overwrite symlinked/);
  assert.equal(fs.readFileSync(outsideSource, "utf8"), "outside");
});

test("migrates a valid legacy learning-paths.json into per-path files on open", (t) => {
  const dir = directory(t);
  const second = { ...clone(makePath()), id: "path-2", title: "Second path" };
  const originalContent = JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision: 4, paths: [makePath(), second] });
  write(
    dir,
    LEARNING_PATHS_FILE,
    originalContent,
  );

  const store = openLearningPathStore(dir);
  assert.equal(store.paths().length, 2);
  assert.equal(fs.existsSync(path.join(dir, LEARNING_PATHS_FILE)), false);
  assert.equal(fs.existsSync(path.join(dir, LEARNING_PATHS_BACKUP_FILE)), true);
  assert.equal(read(dir, LEARNING_PATHS_BACKUP_FILE), originalContent);
  for (const path of [makePath(), second]) {
    const envelope = readPathEnvelope(dir, path.id);
    assert.equal(envelope.schemaVersion, STORE_SCHEMA_VERSION);
    assert.equal(envelope.revision, 4);
    assert.deepEqual(envelope.path, path);
  }
  assert.equal(openLearningPathStore(dir).paths().length, 2);

  const existingDir = directory(t);
  fs.mkdirSync(path.join(existingDir, PATHS_DIRECTORY));
  const existing = { schemaVersion: STORE_SCHEMA_VERSION, revision: 2, path: makePath() };
  write(existingDir, pathFile("path-linear-algebra"), JSON.stringify(existing));
  write(
    existingDir,
    LEARNING_PATHS_FILE,
    JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision: 8, paths: [{ ...makePath(), title: "Legacy" }] }),
  );
  const merged = openLearningPathStore(existingDir);
  assert.equal(merged.path("path-linear-algebra")?.title, makePath().title);
  assert.equal(readPathEnvelope(existingDir, "path-linear-algebra").revision, 2);
  assert.equal(fs.existsSync(path.join(existingDir, LEARNING_PATHS_FILE)), false);
  assert.equal(fs.existsSync(path.join(existingDir, LEARNING_PATHS_BACKUP_FILE)), true);
});

test("refuses corrupt or newer legacy path data without changing a byte", (t) => {
  for (const content of [
    "{ not json",
    JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision: 0, paths: [{ ...makePath(), modules: "nope" }] }),
    JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision: -1, paths: [makePath()] }),
    JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION + 1, revision: 0, paths: [makePath()] }),
  ]) {
    const dir = directory(t);
    fs.mkdirSync(path.join(dir, PATHS_DIRECTORY));
    const existing = JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision: 3, path: makePath() });
    write(dir, pathFile("path-linear-algebra"), existing);
    write(dir, LEARNING_PATHS_FILE, content);
    assert.throws(() => openLearningPathStore(dir), StoreError);
    assert.equal(read(dir, LEARNING_PATHS_FILE), content);
    assert.equal(read(dir, pathFile("path-linear-algebra")), existing);
    assert.equal(fs.existsSync(path.join(dir, LEARNING_PATHS_BACKUP_FILE)), false);
  }
});

test("never touches host-reserved entries or unrelated learner files", (t) => {
  const dir = directory(t);
  fs.mkdirSync(path.join(dir, "agents"));
  fs.mkdirSync(path.join(dir, "tasks"));
  write(dir, "agents/agent.json", '{"keep":"agent"}');
  write(dir, "tasks/task.json", '{"keep":"task"}');
  write(dir, "usage.jsonl", '{"keep":"usage"}\n');
  write(dir, "learner-notes.txt", "do not touch");

  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  store.saveSettings({ artifactDefaults: {} });
  store.writeSource(UUID, "# Source");
  store.readSource(UUID);
  store.deletePath(makePath().id);

  assert.equal(read(dir, "agents/agent.json"), '{"keep":"agent"}');
  assert.equal(read(dir, "tasks/task.json"), '{"keep":"task"}');
  assert.equal(read(dir, "usage.jsonl"), '{"keep":"usage"}\n');
  assert.equal(read(dir, "learner-notes.txt"), "do not touch");
  assert.deepEqual(fs.readdirSync(path.join(dir, "agents")), ["agent.json"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, "tasks")), ["task.json"]);
  assert.deepEqual(fs.readdirSync(path.join(dir, PATHS_DIRECTORY)), []);
  assert.deepEqual(temporaryFiles(dir), []);
  assert.deepEqual(pathsTemporaryFiles(dir), []);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    [
      "agents",
      "learner-notes.txt",
      PATHS_DIRECTORY,
      SETTINGS_FILE,
      SOURCES_DIRECTORY,
      "tasks",
      "usage.jsonl",
    ].sort(),
  );
});

test("a path created at one timestamp reloads unchanged", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  const path = { ...makePath(), createdAt: AT, updatedAt: AT };
  store.savePath(path);
  const reopened = openLearningPathStore(dir).path(path.id);
  assert.deepEqual(reopened, path);
});


test("source uploads dedupe by content hash and keep metadata across restart", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  const markdown = "# Uploaded\n\nA converted chapter.";

  const first = store.saveSource({ name: "chapter.md", markdown });
  assert.equal(first.deduplicated, false);
  assert.equal(first.reference.name, "chapter.md");
  assert.equal(first.reference.byteSize, Buffer.byteLength(markdown, "utf8"));
  assert.match(first.reference.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(store.readSource(first.reference.sourceId), markdown);

  const duplicate = store.saveSource({ name: "copy.md", markdown });
  assert.equal(duplicate.deduplicated, true);
  assert.equal(duplicate.reference.sourceId, first.reference.sourceId);
  assert.equal(store.sources().length, 1);
  assert.deepEqual(store.listSourceIds(), [first.reference.sourceId]);

  const second = store.saveSource({ name: "other.md", markdown: "# Other" });
  assert.equal(second.deduplicated, false);
  const envelope = JSON.parse(read(dir, path.join(SOURCES_DIRECTORY, SOURCE_INDEX_FILE)));
  assert.equal(envelope.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(envelope.revision, 2);
  assert.equal(envelope.sources.length, 2);

  const reopened = openLearningPathStore(dir);
  assert.deepEqual(reopened.sources(), [first.reference, second.reference]);
  assert.throws(() => store.saveSource({ name: "  ", markdown }), /name/);
  assert.throws(() => store.saveSource({ name: "empty.md", markdown: "" }), /non-empty/);

  store.removeSource(first.reference.sourceId);
  assert.equal(store.readSource(first.reference.sourceId), null);
  assert.deepEqual(openLearningPathStore(dir).sources(), [second.reference]);
});

test("refuses a corrupt or newer source index without touching uploads", (t) => {
  for (const content of [
    "{ not json",
    JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision: 0, sources: "nope" }),
    JSON.stringify({
      schemaVersion: STORE_SCHEMA_VERSION,
      revision: 0,
      sources: [{ sourceId: "../outside", name: "x.md", uploadedAt: AT }],
    }),
    JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION + 1, revision: 0, sources: [] }),
  ]) {
    const dir = directory(t);
    fs.mkdirSync(path.join(dir, SOURCES_DIRECTORY), { recursive: true });
    write(dir, path.join(SOURCES_DIRECTORY, SOURCE_INDEX_FILE), content);
    const upload = path.join(dir, SOURCES_DIRECTORY, `${UUID}.md`);
    fs.writeFileSync(upload, "# Keep me");
    assert.throws(() => openLearningPathStore(dir), StoreError);
    assert.equal(fs.readFileSync(upload, "utf8"), "# Keep me");
    assert.equal(read(dir, path.join(SOURCES_DIRECTORY, SOURCE_INDEX_FILE)), content);
  }
});

test("Architect model config round-trips and rejects invalid choices", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  assert.equal(store.architectModel(), null);

  const model = { provider: "pi", id: "strong-model", thinkingLevel: "medium" as const };
  assert.deepEqual(store.saveArchitectModel(model), model);
  assert.deepEqual(openLearningPathStore(dir).architectModel(), model);
  const envelope = JSON.parse(read(dir, ARCHITECT_FILE));
  assert.equal(envelope.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(envelope.revision, 1);
  assert.deepEqual(envelope.model, model);

  assert.throws(() => store.saveArchitectModel({ provider: "pi", id: "m", thinkingLevel: "turbo" }), /thinkingLevel/);
  assert.throws(() => store.saveArchitectModel({ provider: " pi", id: "m" }), /provider/);
  assert.throws(() => store.saveArchitectModel(null), /must be an object/);
  assert.deepEqual(openLearningPathStore(dir).architectModel(), model);
});

test("map revisit setting is opt-in, persists, and rejects non-boolean values", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  assert.equal(store.settings().mapRevisitEnabled ?? false, false);
  store.saveSettings({ artifactDefaults: {}, mapRevisitEnabled: true });
  assert.equal(openLearningPathStore(dir).settings().mapRevisitEnabled, true);
  assert.throws(() => store.saveSettings({ artifactDefaults: {}, mapRevisitEnabled: "true" }), DomainValidationError);
  store.saveSettings({ artifactDefaults: {}, mapRevisitEnabled: false });
  assert.equal(openLearningPathStore(dir).settings().mapRevisitEnabled, false);
});

test("graph context is opt-in, persists, and rejects non-boolean settings", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  assert.equal(store.settings().graphContextEnabled ?? false, false);
  store.saveSettings({ artifactDefaults: {}, graphContextEnabled: true });
  assert.equal(openLearningPathStore(dir).settings().graphContextEnabled, true);
  assert.throws(() => store.saveSettings({ artifactDefaults: {}, graphContextEnabled: "true" }), DomainValidationError);
  store.saveSettings({ artifactDefaults: {}, graphContextEnabled: false });
  assert.equal(openLearningPathStore(dir).settings().graphContextEnabled, false);
});

test("a workspace materializes lazily on the first item and round-trips", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  assert.equal(store.workspace(makePath().id), null);
  assert.equal(fs.existsSync(path.join(dir, WORKSPACES_DIRECTORY)), false);

  const content = "# Feynman attempt\n\nA vector space is a set with structure.";
  const saved = store.saveWorkspaceItem(makePath().id, { kind: "note", title: "Feynman notes", addedBy: "learner" }, content);
  assert.equal(saved.kind, "note");
  assert.equal(saved.byteSize, Buffer.byteLength(content, "utf8"));
  assert.match(saved.sha256 ?? "", /^[0-9a-f]{64}$/);
  assert.match(saved.addedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

  const workspaceDirectory = path.join(dir, WORKSPACES_DIRECTORY, makePath().id);
  assert.deepEqual(fs.readdirSync(workspaceDirectory).sort(), [WORKSPACE_FILES_DIRECTORY, WORKSPACE_MANIFEST_FILE]);
  const expectedFilename = `feynman-notes-${saved.id}.md`;
  assert.deepEqual(fs.readdirSync(path.join(workspaceDirectory, WORKSPACE_FILES_DIRECTORY)), [expectedFilename]);
  assert.equal(fs.statSync(path.join(workspaceDirectory, WORKSPACE_FILES_DIRECTORY, expectedFilename)).mode & 0o077, 0);
  assert.equal(store.readWorkspaceItemContent(makePath().id, saved.id), content);

  const manifest = JSON.parse(read(dir, path.join(WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_MANIFEST_FILE)));
  assert.equal(manifest.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(manifest.pathId, makePath().id);
  assert.equal(manifest.items.length, 1);
  assert.equal(manifest.items[0].byteSize, saved.byteSize);

  const reopened = openLearningPathStore(dir);
  assert.equal(reopened.workspace(makePath().id)?.items.length, 1);
  assert.equal(reopened.readWorkspaceItemContent(makePath().id, saved.id), content);
  // Additive: the path and settings files round-trip untouched.
  assert.deepEqual(reopened.path(makePath().id), makePath());

  const other = { ...clone(makePath()), id: "path-2", title: "Second path" };
  store.savePath(other);
  assert.equal(store.workspace(other.id), null);
  assert.equal(fs.existsSync(path.join(dir, WORKSPACES_DIRECTORY, other.id)), false);
});

test("notes round-trip Markdown verbatim and content caps hold", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const verbatim = "\n#  Kept   exactly\n\n- even   this  \n";
  const saved = store.saveWorkspaceItem(makePath().id, { kind: "note", title: "Verbatim", addedBy: "learner" }, verbatim);
  assert.equal(store.readWorkspaceItemContent(makePath().id, saved.id), verbatim);

  const oversized = "x".repeat(256 * 1024 + 1);
  assert.throws(
    () => store.saveWorkspaceItem(makePath().id, { kind: "note", title: "Too big", addedBy: "learner" }, oversized),
    (error: unknown) => error instanceof StoreError && /limit is 262144/.test(error.message),
  );
  assert.equal(fs.readdirSync(path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_FILES_DIRECTORY)).length, 1);

  assert.throws(
    () => store.saveWorkspaceItem(makePath().id, { kind: "note", title: "Empty", addedBy: "learner" }, ""),
    /needs non-empty Markdown content/,
  );
  assert.throws(
    () => store.saveWorkspaceItem(makePath().id, { kind: "note", title: "Empty", addedBy: "learner" }),
    /needs non-empty Markdown content/,
  );
});

test("source items reference the global sources store and carry no content file", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const uploaded = store.saveSource({ name: "chapter.md", markdown: "# A chapter." });

  const saved = store.saveWorkspaceItem(
    makePath().id,
    { kind: "source", title: "A chapter", addedBy: "learner", sourceId: uploaded.reference.sourceId },
  );
  assert.equal(saved.sourceId, uploaded.reference.sourceId);
  assert.equal(
    fs.readdirSync(path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_FILES_DIRECTORY)).length,
    0,
  );
  assert.equal(store.readWorkspaceItemContent(makePath().id, saved.id), null);
  // The referenced source is untouched and still global.
  assert.equal(store.readSource(uploaded.reference.sourceId), "# A chapter.");

  assert.throws(
    () => store.saveWorkspaceItem(makePath().id, { kind: "source", title: "Ghost", addedBy: "learner", sourceId: UUID }),
    /unknown source/,
  );
  assert.throws(
    () =>
      store.saveWorkspaceItem(
        makePath().id,
        { kind: "source", title: "Ghost", addedBy: "learner", sourceId: UUID },
        "content",
      ),
    /carries no content file/,
  );
  assert.throws(
    () => store.saveWorkspaceItem(makePath().id, { kind: "note", title: "Note", addedBy: "learner", sourceId: UUID }, "x"),
    DomainValidationError,
  );
});

test("workspace writes require an existing path and validate links against real node ids", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  assert.throws(() => store.saveWorkspaceItem("path-missing", { kind: "note", title: "x", addedBy: "learner" }, "c"), /Unknown learning path/);

  store.savePath(makePath());
  assert.throws(
    () =>
      store.saveWorkspaceItem(
        makePath().id,
        { kind: "note", title: "Linked", addedBy: "learner", links: [{ to: "n-missing", rel: "grounds" }] },
        "c",
      ),
    (error: unknown) => error instanceof DomainValidationError && /unknown node id "n-missing"/.test(error.message),
  );
  assert.equal(store.workspace(makePath().id), null, "a rejected save materializes nothing");

  const spaceLink = store.saveWorkspaceItem(
    makePath().id,
    { kind: "note", title: "Space", addedBy: "learner", links: [{ to: "space", rel: "informs" }, { to: "n-concept", rel: "grounds" }] },
    "c",
  );
  assert.deepEqual(store.workspace(makePath().id)?.items[0]?.links, [
    { to: "space", rel: "informs" },
    { to: "n-concept", rel: "grounds" },
  ]);

  assert.throws(
    () => store.saveWorkspaceItem(makePath().id, { id: spaceLink.id, kind: "note", title: "Dup", addedBy: "learner" }, "c"),
    (error: unknown) => error instanceof StoreError && /already exists/.test(error.message),
  );
  assert.equal(store.workspace(makePath().id)?.items.length, 1, "a rejected duplicate save adds nothing");
  assert.throws(
    () => store.saveWorkspaceItem(makePath().id, { kind: "note", title: "Bad provenance", addedBy: "ghost" }, "c"),
    DomainValidationError,
  );
});

test("the 300-item cap is enforced by the resulting manifest, not just one save", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  for (let index = 0; index < 300; index += 1) {
    store.saveWorkspaceItem(
      makePath().id,
      { kind: "note", title: `Note ${index}`, addedBy: "learner" },
      `content ${index}`,
    );
  }
  assert.equal(store.workspace(makePath().id)?.items.length, 300);
  assert.throws(
    () => store.saveWorkspaceItem(makePath().id, { kind: "note", title: "One too many", addedBy: "learner" }, "c"),
    /items: a workspace carries at most 300 items/,
  );
  assert.equal(fs.readdirSync(path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_FILES_DIRECTORY)).length, 300);
});

test("meta updates touch only title, caption and links", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const saved = store.saveWorkspaceItem(
    makePath().id,
    { kind: "note", title: "Draft", addedBy: "learner", links: [{ to: "n-concept", rel: "grounds" }] },
    "content",
  );
  const filesDir = path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_FILES_DIRECTORY);
  const contentBefore = read(dir, path.join(WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_FILES_DIRECTORY, `draft-${saved.id}.md`));

  const updated = store.updateWorkspaceItemMeta(
    makePath().id,
    saved.id,
    { title: "Renamed", caption: "Second pass", links: [{ to: "n-skill", rel: "informs" }] },
  );
  assert.equal(updated.title, "Renamed");
  assert.equal(updated.caption, "Second pass");
  assert.equal(updated.addedAt, saved.addedAt);
  assert.equal(updated.sha256, saved.sha256, "content metadata never drifts");
  const renamedFile = path.join(filesDir, `renamed-${saved.id}.md`);
  const strippedBefore = contentBefore.split("\n---\n").at(-1)?.replace(/^\n+/, "");
  const strippedAfter = fs.readFileSync(renamedFile, "utf8").split("\n---\n").at(-1)?.replace(/^\n+/, "");
  assert.equal(strippedAfter, strippedBefore, "title renames move the file and preserve content");
  assert.deepEqual(store.workspace(makePath().id)?.items[0]?.links, [{ to: "n-skill", rel: "informs" }]);

  const cleared = store.updateWorkspaceItemMeta(makePath().id, saved.id, { caption: null });
  assert.equal("caption" in cleared, false);

  assert.throws(
    () => store.updateWorkspaceItemMeta(makePath().id, saved.id, { kind: "code" }),
    /accepts only title, caption, links/,
  );
  assert.throws(
    () => store.updateWorkspaceItemMeta(makePath().id, saved.id, { links: [{ to: "n-missing", rel: "grounds" }] }),
    /unknown node id "n-missing"/,
  );
  assert.throws(() => store.updateWorkspaceItemMeta(makePath().id, ITEM_ID, { title: "x" }), /not found/);
  assert.equal(read(dir, path.join(WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_MANIFEST_FILE)) !== contentBefore, true);
});

test("deleting an item removes it and its content file, never the sources store", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const note = store.saveWorkspaceItem(makePath().id, { kind: "note", title: "Note", addedBy: "learner" }, "note content");
  const uploaded = store.saveSource({ name: "chapter.md", markdown: "# A chapter." });
  const source = store.saveWorkspaceItem(
    makePath().id,
    { kind: "source", title: "Chapter", addedBy: "learner", sourceId: uploaded.reference.sourceId },
  );

  assert.equal(store.deleteWorkspaceItem(makePath().id, ITEM_ID), false);
  assert.equal(store.deleteWorkspaceItem(makePath().id, note.id), true);
  assert.equal(store.workspace(makePath().id)?.items.length, 1);
  assert.equal(
    fs.existsSync(path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_FILES_DIRECTORY, `${note.id}.md`)),
    false,
  );
  assert.equal(store.readWorkspaceItemContent(makePath().id, note.id), null);

  assert.equal(store.deleteWorkspaceItem(makePath().id, source.id), true);
  assert.equal(store.workspace(makePath().id)?.items.length, 0);
  assert.equal(store.readSource(uploaded.reference.sourceId), "# A chapter.", "sources/ stays global");
});

test("a corrupt or newer workspace manifest throws and is never wiped or written over", (t) => {
  const corruptCases = [
    "{ not json",
    JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, pathId: makePath().id, updatedAt: AT, items: [{ id: ITEM_ID, kind: "note", title: "x", addedAt: AT, addedBy: "learner", links: [] }] }).replace('"learner"', '"ghost"'),
    JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION + 1, pathId: makePath().id, updatedAt: AT, items: [] }),
    JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, pathId: "path-other", updatedAt: AT, items: [] }),
    JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, pathId: makePath().id, updatedAt: AT, items: "nope" }),
  ];
  for (const [index, content] of corruptCases.entries()) {
    const dir = directory(t);
    const store = openLearningPathStore(dir);
    store.savePath(makePath());
    const manifestFile = path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_MANIFEST_FILE);
    fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
    fs.writeFileSync(manifestFile, content);

    assert.throws(
      () => store.workspace(makePath().id),
      (error: unknown) => {
        if (!(error instanceof StoreError)) return false;
        return index === 3 ? error.code === "corrupt" : ["corrupt", "newer-schema"].includes(error.code);
      },
      `accepted manifest case ${index}`,
    );
    assert.throws(
      () => store.saveWorkspaceItem(makePath().id, { kind: "note", title: "Overwrite", addedBy: "learner" }, "c"),
      StoreError,
      `wrote over manifest case ${index}`,
    );
    assert.equal(fs.readFileSync(manifestFile, "utf8"), content, `manifest case ${index} was changed`);
    assert.throws(() => store.readWorkspaceItemContent(makePath().id, ITEM_ID), StoreError, `content read over manifest case ${index}`);
  }
});

test("links to deleted nodes drop at read with the item kept, and only paths.delete removes a workspace", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const saved = store.saveWorkspaceItem(
    makePath().id,
    { kind: "note", title: "Linked", addedBy: "learner", links: [{ to: "n-concept", rel: "grounds" }] },
    "content",
  );
  // Simulate a node disappearing between writes: inject the stale link on disk,
  // exactly what a manifest written before the node was deleted looks like.
  const manifestFile = path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_MANIFEST_FILE);
  const onDisk = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  onDisk.items[0].links.push({ to: "n-missing", rel: "informs" });
  fs.writeFileSync(manifestFile, JSON.stringify(onDisk, null, 2) + "\n");

  const read = store.workspace(makePath().id);
  assert.equal(read?.items[0]?.id, saved.id);
  assert.deepEqual(read?.items[0]?.links, [{ to: "n-concept", rel: "grounds" }]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(manifestFile, "utf8")).items[0].links,
    [{ to: "n-concept", rel: "grounds" }, { to: "n-missing", rel: "informs" }],
    "read never rewrites",
  );

  const second = { ...clone(makePath()), id: "path-2", title: "Second path" };
  store.savePath(second);
  store.saveWorkspaceItem(second.id, { kind: "note", title: "Keep me", addedBy: "learner" }, "keep");
  assert.equal(store.deletePath(second.id), true);
  assert.equal(fs.existsSync(path.join(dir, WORKSPACES_DIRECTORY, second.id)), false);
  assert.equal(fs.existsSync(path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_MANIFEST_FILE)), true);
  assert.equal(store.workspace(second.id), null);

  const guardDir = directory(t);
  const guardStore = openLearningPathStore(guardDir);
  guardStore.savePath(makePath());
  guardStore.saveWorkspaceItem(makePath().id, { kind: "note", title: "Guarded", addedBy: "learner" }, "content");
  const outside = path.join(guardDir, "outside");
  fs.mkdirSync(outside);
  fs.renameSync(
    path.join(guardDir, WORKSPACES_DIRECTORY, makePath().id),
    path.join(outside, "workspace"),
  );
  fs.symlinkSync(
    path.join(outside, "workspace"),
    path.join(guardDir, WORKSPACES_DIRECTORY, makePath().id),
  );
  assert.throws(
    () => guardStore.deletePath(makePath().id),
    (error: unknown) => error instanceof StoreError && error.code === "unsafe" && /symlinked workspace/.test(error.message),
  );
  assert.equal(fs.readFileSync(path.join(outside, "workspace", WORKSPACE_MANIFEST_FILE)).length > 0, true);
  assert.equal(guardStore.path(makePath().id)?.id, makePath().id, "the path survives when the workspace cannot be removed safely");
});

test("refuses symlinked workspace files and directories instead of following them", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const saved = store.saveWorkspaceItem(makePath().id, { kind: "note", title: "Note", addedBy: "learner" }, "content");

  const outside = path.join(dir, "outside.md");
  fs.writeFileSync(outside, "outside");
  const filesDir = path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_FILES_DIRECTORY);
  const entries = fs.readdirSync(filesDir);
  const contentFile = entries.length === 1 ? path.join(filesDir, entries[0]!) : path.join(filesDir, `${saved.id}.md`);
  fs.rmSync(contentFile);
  fs.symlinkSync(outside, contentFile);
  assert.throws(
    () => store.readWorkspaceItemContent(makePath().id, saved.id),
    (error: unknown) => error instanceof StoreError && /symlinked workspace file/.test(error.message),
  );
  assert.equal(fs.readFileSync(outside, "utf8"), "outside");
  assert.throws(
    () => store.deleteWorkspaceItem(makePath().id, saved.id),
    (error: unknown) => error instanceof StoreError && /symlinked workspace file/.test(error.message),
  );
  assert.equal(store.workspace(makePath().id)?.items.length, 1, "a refused delete keeps the item");

  const filesLink = directory(t);
  const linkStore = openLearningPathStore(filesLink);
  linkStore.savePath(makePath());
  const filesDirectory = path.join(filesLink, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_FILES_DIRECTORY);
  fs.mkdirSync(filesDirectory, { recursive: true });
  fs.renameSync(filesDirectory, path.join(filesLink, "real-files"));
  fs.symlinkSync(path.join(filesLink, "real-files"), filesDirectory);
  assert.throws(
    () => linkStore.saveWorkspaceItem(makePath().id, { kind: "note", title: "Through a symlink", addedBy: "learner" }, "c"),
    (error: unknown) => error instanceof StoreError && /symlinked workspace/.test(error.message),
  );

  const workspacesLink = directory(t);
  fs.mkdirSync(path.join(workspacesLink, "outside-workspaces"));
  fs.symlinkSync(path.join(workspacesLink, "outside-workspaces"), path.join(workspacesLink, WORKSPACES_DIRECTORY));
  assert.throws(() => openLearningPathStore(workspacesLink), /symlinked Learning Path directory/);
});

test("content files carry readable slugs and frontmatter that round-trips awkward titles", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  // Quotes, a backslash and unicode: the frontmatter escaping must round-trip.
  const title = 'He said "hi" \\ and stayed';
  const content = "# Verbatim body\n";
  const saved = store.saveWorkspaceItem(
    makePath().id,
    { kind: "note", title, addedBy: "learner", links: [{ to: "n-skill", rel: "informs" }] },
    content,
  );

  const filesDir = path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_FILES_DIRECTORY);
  const files = fs.readdirSync(filesDir);
  assert.equal(files.length, 1);
  assert.match(files[0]!, /^he-said-hi-and-stayed-[0-9a-f-]{36}\.md$/, "the filename is the title's slug plus the id");
  assert.equal(store.readWorkspaceItemContent(makePath().id, saved.id), content, "content reads verbatim, frontmatter stripped");

  // Frontmatter carries the filing so an external editor can see it.
  const raw = fs.readFileSync(path.join(filesDir, files[0]!), "utf8");
  assert.match(raw, /^---\n/);
  assert.match(raw, new RegExp(`^kind: note$`, "m"));
  assert.match(raw, /^  - to: n-skill$/m);
  assert.match(raw, /^    rel: informs$/m);
  assert.ok(raw.endsWith(content), "the note body follows the frontmatter untouched");
});

test("syncWorkspaceFromFiles: an external edit to frontmatter and body wins over the manifest", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const saved = store.saveWorkspaceItem(
    makePath().id,
    { kind: "note", title: "Lecture 7 questions", addedBy: "learner", links: [{ to: "n-concept", rel: "informs" }] },
    "original body",
  );

  // The learner edits the file in their own editor: new title, a new link,
  // and a body edit. The manifest is untouched until the next sync.
  const filesDir = path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_FILES_DIRECTORY);
  const filename = fs.readdirSync(filesDir)[0]!;
  fs.writeFileSync(path.join(filesDir, filename), [
    "---",
    `id: "${saved.id}"`,
    "kind: note",
    'title: "Lecture 7 — open questions"',
    `addedAt: "${saved.addedAt}"`,
    "links:",
    "  - to: n-contrast",
    "    rel: informs",
    "  - to: n-missing",
    "    rel: grounds",
    "---",
    "rewritten in my editor",
    "",
  ].join("\n"));

  const before = store.workspace(makePath().id);
  assert.equal(before?.items[0]?.title, "Lecture 7 questions");
  const result = store.syncWorkspaceFromFiles(makePath().id);
  assert.equal(result.changed, true);
  const synced = store.workspace(makePath().id)!.items[0]!;
  assert.equal(synced.title, "Lecture 7 — open questions", "the external title wins");
  assert.deepEqual(
    synced.links,
    [{ to: "n-contrast", rel: "informs" }],
    "links follow the file, with the unknown node dropped exactly as at read",
  );
  assert.equal(store.readWorkspaceItemContent(makePath().id, saved.id), "rewritten in my editor\n");
  assert.equal(synced.byteSize, Buffer.byteLength("rewritten in my editor\n", "utf8"));
  assert.match(synced.sha256 ?? "", /^[0-9a-f]{64}$/, "the index describes the file that is on disk");

  // A second sync with nothing further changed rewrites nothing.
  const stable = store.syncWorkspaceFromFiles(makePath().id);
  assert.equal(stable.changed, false, "an unchanged workspace is not rewritten");
});

test("syncWorkspaceFromFiles: a file written outside the harness materializes as a learner item", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const saved = store.saveWorkspaceItem(
    makePath().id,
    { kind: "note", title: "In-app note", addedBy: "learner" },
    "in-app body",
  );
  const filesDir = path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_FILES_DIRECTORY);

  const externalId = "11111111-2222-3333-4444-555555555555";
  fs.writeFileSync(path.join(filesDir, `after-the-lecture-${externalId}.md`), [
    "---",
    `id: "${externalId}"`,
    "kind: note",
    'title: "Notes after DSA lecture 7"',
    'addedAt: "2026-03-01T10:00:00.000Z"',
    "links:",
    "  - to: n-contrast",
    "    rel: informs",
    "---",
    "Why does DFS not give shortest paths?",
    "",
  ].join("\n"));

  const result = store.syncWorkspaceFromFiles(makePath().id);
  assert.equal(result.changed, true);
  const items = store.workspace(makePath().id)!.items;
  assert.equal(items.length, 2, "the external file became an item; the in-app note stays");
  const materialized = items.find((item) => item.id === externalId)!;
  assert.equal(materialized.title, "Notes after DSA lecture 7");
  assert.equal(materialized.addedBy, "learner", "material written outside is learner-owned");
  assert.deepEqual(materialized.links, [{ to: "n-contrast", rel: "informs" }]);
  assert.equal(store.readWorkspaceItemContent(makePath().id, externalId), "Why does DFS not give shortest paths?\n");
  assert.equal(items.find((item) => item.id === saved.id)!.title, "In-app note");

  // A file with no frontmatter never syncs: the store never guesses ownership.
  fs.writeFileSync(path.join(filesDir, "loose-thoughts.md"), "no frontmatter at all\n");
  const ignored = store.syncWorkspaceFromFiles(makePath().id);
  assert.equal(ignored.changed, false);

  // Oversize external content never materializes, exactly like in-app writes.
  fs.writeFileSync(path.join(filesDir, `huge-11111111-2222-3333-4444-555555555556.md`), [
    "---",
    'id: "11111111-2222-3333-4444-555555555556"',
    "kind: note",
    'title: "Too big"',
    'addedAt: "2026-03-01T10:00:00.000Z"',
    "---",
    "x".repeat(256 * 1024 + 1),
  ].join("\n"));
  const refused = store.syncWorkspaceFromFiles(makePath().id);
  assert.equal(refused.changed, false);
  assert.equal(store.workspace(makePath().id)!.items.length, 2);
});

test("syncWorkspaceFromFiles never follows symlinks and never deletes on a missing file", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const saved = store.saveWorkspaceItem(
    makePath().id,
    { kind: "note", title: "Keep me", addedBy: "learner" },
    "body",
  );
  const filesDir = path.join(dir, WORKSPACES_DIRECTORY, makePath().id, WORKSPACE_FILES_DIRECTORY);

  // A symlinked file is skipped, never followed into the scan.
  const outside = path.join(dir, "outside.md");
  fs.writeFileSync(outside, [
    "---",
    'id: "99999999-9999-9999-9999-999999999999"',
    "kind: note",
    'title: "Through a link"',
    'addedAt: "2026-03-01T10:00:00.000Z"',
    "---",
    "outside body",
  ].join("\n"));
  fs.symlinkSync(outside, path.join(filesDir, "linked-99999999-9999-9999-9999-999999999999.md"));
  const throughLink = store.syncWorkspaceFromFiles(makePath().id);
  assert.equal(throughLink.changed, false);
  assert.equal(store.workspace(makePath().id)!.items.length, 1, "nothing materialized through the symlink");

  // A vanished file leaves its manifest entry alone: deletion is a learner decision.
  fs.rmSync(path.join(filesDir, fs.readdirSync(filesDir).find((name) => name.endsWith(`${saved.id}.md`))!));
  const afterRemoval = store.syncWorkspaceFromFiles(makePath().id);
  assert.equal(afterRemoval.changed, false);
  assert.equal(store.workspace(makePath().id)!.items.length, 1, "the entry survives a missing file");
});
