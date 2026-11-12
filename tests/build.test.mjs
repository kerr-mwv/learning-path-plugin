/** Build guard tests: dist/ layout, manifest validity, and refusal to touch learner data. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../", import.meta.url));
const sourceManifest = JSON.parse(fs.readFileSync(path.join(project, "manifest.json"), "utf8"));

/** A disposable copy of everything `npm run build` reads, with node_modules linked in. */
function fixture({ manifest = sourceManifest } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-build-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(project, "scripts/build.mjs"), path.join(root, "scripts/build.mjs"));
  fs.cpSync(path.join(project, "src"), path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.symlinkSync(path.join(project, "node_modules"), path.join(root, "node_modules"));
  return {
    root,
    dist: path.join(root, "dist"),
    run: () => spawnSync(process.execPath, [path.join(root, "scripts/build.mjs")], { cwd: root, encoding: "utf8" }),
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function built() {
  const f = fixture();
  const result = f.run();
  assert.equal(result.status, 0, `build failed:\n${result.stderr}`);
  return f;
}

test("manifest is valid for plugin API v1 on LearnHarness 0.6.0", () => {
  assert.equal(sourceManifest.apiVersion, 1);
  assert.equal(sourceManifest.id, "learning-path");
  assert.equal(sourceManifest.name, "Learning Paths");
  assert.match(sourceManifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(sourceManifest.version, "0.1.0");
  assert.equal(sourceManifest.minAppVersion, "0.6.0");
  assert.equal(sourceManifest.main, "main.js");
  assert.equal(sourceManifest.backend, "backend.cjs");
  assert.equal(sourceManifest.styles, "styles.css");
  assert.ok(sourceManifest.description?.trim());
});

test("build emits exactly the declared dist layout", () => {
  const f = built();
  try {
    const entries = fs.readdirSync(f.dist).sort();
    assert.deepEqual(entries, ["backend.cjs", "main.js", "manifest.json", "styles.css"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dist, "manifest.json"), "utf8")), sourceManifest);
    assert.equal(
      fs.readFileSync(path.join(f.dist, "styles.css"), "utf8"),
      fs.readFileSync(path.join(project, "src/styles.css"), "utf8"),
    );
    // Browser bundle is an ES module; backend bundle is CommonJS with a node builtin left external.
    assert.match(fs.readFileSync(path.join(f.dist, "main.js"), "utf8"), /export/);
    const backend = fs.readFileSync(path.join(f.dist, "backend.cjs"), "utf8");
    assert.match(backend, /module\.exports|exports\.activate/);
    assert.equal(fs.existsSync(path.join(f.dist, "data")), false);
    assert.equal(fs.existsSync(path.join(f.dist, "node_modules")), false);
    assert.equal(fs.existsSync(path.join(f.dist, "src")), false);
  } finally {
    f.close();
  }
});

test("built backend activates and answers its operation", () => {
  const f = built();
  try {
    const require = createRequire(import.meta.url);
    const backend = require(path.join(f.dist, "backend.cjs"));
    assert.equal(typeof backend.activate, "function");
    const handlers = new Map();
    const cleanups = [];
    backend.activate({
      manifest: sourceManifest,
      directory: f.dist,
      dataDirectory: path.join(f.root, "data"),
      signal: new AbortController().signal,
      cleanup: (fn) => cleanups.push(fn),
      handle: (name, handler) => {
        handlers.set(name, handler);
        return () => handlers.delete(name);
      },
      registerInstructions: () => () => {},
      registerTools: () => () => {},
    });
    assert.deepEqual(handlers.get("paths.status")(), {
      id: "learning-path",
      version: "0.1.0",
      active: true,
    });
    // Every activation resource is registered for teardown, including the
    // Architect lifecycle and the abort fence.
    assert.ok(cleanups.length >= 1);
    cleanups.reverse().forEach((fn) => fn());
    assert.equal(handlers.size, 0);
  } finally {
    f.close();
  }
});

test("build preserves the sibling data directory", () => {
  const f = fixture();
  try {
    const data = path.join(f.root, "data");
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, "learning-paths.json"), '{"keep":true}');
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(data, "learning-paths.json"), "utf8"), '{"keep":true}');
  } finally {
    f.close();
  }
});

test("build refuses a symlinked dist without deleting its target", () => {
  const f = fixture();
  try {
    const target = path.join(f.root, "preserve");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "marker"), "keep");
    fs.symlinkSync(target, f.dist);
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /symlinked dist/);
    assert.equal(fs.readFileSync(path.join(target, "marker"), "utf8"), "keep");
  } finally {
    f.close();
  }
});

test("build refuses a misplaced dist/data directory without deleting it", () => {
  const f = fixture();
  try {
    const data = path.join(f.dist, "data");
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, "learning-paths.json"), '{"keep":true}');
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dist\/data/);
    assert.equal(fs.readFileSync(path.join(data, "learning-paths.json"), "utf8"), '{"keep":true}');
  } finally {
    f.close();
  }
});

test("build refuses a symlinked dist/data entry without deleting its target", () => {
  const f = fixture();
  try {
    const target = path.join(f.root, "real-data");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "marker"), "keep");
    fs.mkdirSync(f.dist);
    fs.symlinkSync(target, path.join(f.dist, "data"));
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /dist\/data/);
    assert.equal(fs.readFileSync(path.join(target, "marker"), "utf8"), "keep");
  } finally {
    f.close();
  }
});

test("build refuses an invalid manifest and leaves the previous dist intact", () => {
  for (const manifest of [
    { ...sourceManifest, apiVersion: 2 },
    { ...sourceManifest, id: "Learning Path" },
    { ...sourceManifest, version: "0.1" },
    { ...sourceManifest, minAppVersion: "latest" },
    { ...sourceManifest, main: undefined, backend: undefined, styles: undefined },
    { ...sourceManifest, main: undefined },
    { ...sourceManifest, main: "nested/main.js" },
  ]) {
    const f = fixture({ manifest });
    try {
      fs.mkdirSync(f.dist);
      fs.writeFileSync(path.join(f.dist, "main.js"), "previous build");
      const result = f.run();
      assert.notEqual(result.status, 0, `accepted invalid manifest: ${JSON.stringify(manifest)}`);
      assert.equal(fs.readFileSync(path.join(f.dist, "main.js"), "utf8"), "previous build");
    } finally {
      f.close();
    }
  }
});

test("build refuses a manifest entry that the build did not produce", () => {
  const f = fixture({ manifest: { ...sourceManifest, main: "missing.js" } });
  try {
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing build output/);
  } finally {
    f.close();
  }
});
