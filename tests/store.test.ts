/** Atomic, versioned persistence under ctx.dataDirectory. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DomainValidationError } from "../src/domain.ts";
import {
  ARCHITECT_FILE,
  LEARNING_PATHS_FILE,
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
const temporaryFiles = (dir: string): string[] =>
  fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"));

test("saves, replaces and reloads paths with a versioned envelope", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  assert.deepEqual(store.paths(), []);
  assert.equal(store.path("path-linear-algebra"), null);
  assert.deepEqual(store.settings(), { artifactDefaults: {} });

  const saved = store.savePath(makePath());
  assert.deepEqual(saved, makePath());
  const envelope = JSON.parse(read(dir, LEARNING_PATHS_FILE));
  assert.equal(envelope.schemaVersion, STORE_SCHEMA_VERSION);
  assert.equal(envelope.revision, 1);
  assert.deepEqual(envelope.paths, [makePath()]);

  const second = { ...clone(makePath()), id: "path-2", title: "Second path" };
  store.savePath(second);
  store.savePath({ ...makePath(), title: "Renamed in place" });

  const reopened = openLearningPathStore(dir);
  assert.equal(reopened.paths().length, 2);
  assert.equal(reopened.path("path-linear-algebra")?.title, "Renamed in place");
  assert.deepEqual(JSON.parse(read(dir, LEARNING_PATHS_FILE)).revision, 3);

  assert.equal(reopened.deletePath("path-missing"), false);
  assert.equal(reopened.deletePath("path-2"), true);
  assert.equal(reopened.paths().length, 1);
  assert.equal(openLearningPathStore(dir).path("path-2"), null);
});

test("a failed atomic rename keeps memory, previous bytes and no temporary file", (t) => {
  const dir = directory(t);
  const store = openLearningPathStore(dir);
  store.savePath(makePath());
  const before = read(dir, LEARNING_PATHS_FILE);
  const beforePaths = clone(store.paths());

  t.mock.method(fs, "renameSync", () => {
    throw new Error("Synthetic rename failure");
  });
  assert.throws(() => store.savePath({ ...makePath(), title: "Never persisted" }), /Synthetic rename failure/);

  assert.deepEqual(store.paths(), beforePaths);
  assert.equal(read(dir, LEARNING_PATHS_FILE), before);
  assert.deepEqual(temporaryFiles(dir), []);
  assert.deepEqual(openLearningPathStore(dir).paths(), beforePaths);
});

test("refuses corrupt JSON and invalid records without changing a byte", (t) => {
  for (const content of [
    "{ not json",
    JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION, revision: 0, paths: "nope" }),
    JSON.stringify({
      schemaVersion: STORE_SCHEMA_VERSION,
      revision: 0,
      paths: [{ ...makePath(), modules: "nope" }],
    }),
    JSON.stringify({
      schemaVersion: STORE_SCHEMA_VERSION,
      revision: -1,
      paths: [makePath()],
    }),
    JSON.stringify({
      schemaVersion: 0,
      revision: 0,
      paths: [makePath()],
    }),
  ]) {
    const dir = directory(t);
    write(dir, LEARNING_PATHS_FILE, content);
    assert.throws(
      () => openLearningPathStore(dir),
      (error: unknown) => error instanceof StoreError && /corrupt/.test(error.message),
      `accepted corrupt content: ${content}`,
    );
    assert.equal(read(dir, LEARNING_PATHS_FILE), content);
  }
});

test("refuses a newer schema version instead of wiping learner data", (t) => {
  const dir = directory(t);
  const content = JSON.stringify({ schemaVersion: STORE_SCHEMA_VERSION + 1, revision: 9, paths: [makePath()] });
  write(dir, LEARNING_PATHS_FILE, content);
  assert.throws(
    () => openLearningPathStore(dir),
    (error: unknown) =>
      error instanceof StoreError &&
      error.code === "newer-schema" &&
      /newer schema version 2/.test(error.message) &&
      /No data was changed/.test(error.message),
  );
  assert.equal(read(dir, LEARNING_PATHS_FILE), content);

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

test("refuses symlinked managed files instead of following them outside the store", (t) => {
  const dir = directory(t);
  const outside = path.join(dir, "outside.json");
  write(dir, "outside.json", JSON.stringify({ keep: true }));
  fs.symlinkSync(outside, path.join(dir, LEARNING_PATHS_FILE));
  assert.throws(() => openLearningPathStore(dir), /symlinked/);
  assert.equal(read(dir, "outside.json"), JSON.stringify({ keep: true }));

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
  assert.deepEqual(temporaryFiles(dir), []);
  assert.deepEqual(
    fs.readdirSync(dir).sort(),
    ["agents", "learner-notes.txt", LEARNING_PATHS_FILE, SETTINGS_FILE, SOURCES_DIRECTORY, "tasks", "usage.jsonl"].sort(),
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
