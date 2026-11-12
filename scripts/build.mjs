/** Build the Learning Path plugin into `dist/` only.
 * Safety first: a broken build must never delete or overwrite learner data.
 * Run from anywhere; the project root is resolved from this script's location. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ENTRY_EXTENSIONS = { main: ".js", backend: ".cjs", styles: ".css" };

function fail(message) {
  throw new Error(message);
}

/** Reject anything that could make the cleanup below unsafe. */
function assertSafeOutput() {
  const dist = fs.lstatSync(output, { throwIfNoEntry: false });
  if (dist?.isSymbolicLink()) fail("Refusing to build into a symlinked dist directory.");
  if (dist && !dist.isDirectory()) fail(`Refusing to build over non-directory dist: ${output}`);
  // A misplaced data/ inside dist/ may be real learner data (or a link to it).
  if (fs.lstatSync(path.join(output, "data"), { throwIfNoEntry: false })) {
    fail("Refusing to build over dist/data; preserve plugin data outside dist first.");
  }
}

/** Validate the manifest before and after building, mirroring the host's rules. */
function readManifest(directory) {
  const filename = path.join(directory, "manifest.json");
  if (!fs.existsSync(filename)) fail(`Missing plugin manifest: ${filename}`);
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Manifest must be a JSON object.");
  if (value.apiVersion !== 1) fail("Manifest apiVersion must be 1.");
  if (typeof value.id !== "string" || !ID.test(value.id)) fail("Manifest id must be a lowercase-hyphen slug.");
  if (typeof value.name !== "string" || !value.name.trim()) fail("Manifest name is required.");
  for (const key of ["version", "minAppVersion"]) {
    if (typeof value[key] !== "string" || !SEMVER.test(value[key])) fail(`Manifest ${key} must be a numeric x.y.z version.`);
  }
  for (const key of ["description", "author"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") fail(`Manifest ${key} must be a string.`);
  }
  if (!value.main && !value.backend) fail("A plugin needs a main or backend entry.");
  if (value.styles && !value.main) fail("Manifest styles requires a frontend main entry.");
  for (const [key, extension] of Object.entries(ENTRY_EXTENSIONS)) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value[key]) || !value[key].endsWith(extension)) {
      fail(`Manifest ${key} must name a root ${extension} file.`);
    }
  }
  return value;
}

assertSafeOutput();
const manifest = readManifest(root);

// Clean only the generated output directory; never the workspace, dist/data, or sibling data/.
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const common = {
  absWorkingDir: root,
  bundle: true,
  target: "es2022",
  minify: true,
  legalComments: "eof",
  metafile: true,
  logLevel: "warning",
};
const frontend = await build({
  ...common,
  entryPoints: ["src/main.ts"],
  outfile: path.join(output, "main.js"),
  format: "esm",
  platform: "browser",
});
const backend = await build({
  ...common,
  entryPoints: ["src/backend.ts"],
  outfile: path.join(output, "backend.cjs"),
  format: "cjs",
  platform: "node",
  external: ["node:*"],
});

for (const [label, result] of [["frontend", frontend], ["backend", backend]]) {
  for (const input of Object.keys(result.metafile.inputs)) {
    if (!input.startsWith("src/") && !input.startsWith("node_modules/")) {
      fail(`Unexpected ${label} runtime input: ${input}`);
    }
  }
}

fs.copyFileSync(path.join(root, "src/styles.css"), path.join(output, "styles.css"));
fs.copyFileSync(path.join(root, "manifest.json"), path.join(output, "manifest.json"));

// Every declared entry must exist at the root of dist/ under its exact filename.
for (const key of Object.keys(ENTRY_EXTENSIONS)) {
  if (manifest[key] === undefined) continue;
  const filename = path.join(output, manifest[key]);
  if (!fs.lstatSync(filename, { throwIfNoEntry: false })?.isFile()) fail(`Manifest ${key} names a missing build output: ${manifest[key]}`);
}

if (fs.lstatSync(path.join(output, "data"), { throwIfNoEntry: false })) fail("Build produced dist/data; refusing to ship learner data.");

console.log(`Built Learning Path plugin into ${output}`);
