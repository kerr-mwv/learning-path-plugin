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
  openLearningPathStore,
} from "../src/store.ts";
import { AT, clone, makePath } from "./fixtures.ts";

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
