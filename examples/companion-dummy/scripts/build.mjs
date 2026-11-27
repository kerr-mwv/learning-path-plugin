/** Build the companion demo into examples/companion-dummy/dist only.
 * Mirrors the Learning Path build's safety posture on a budget: never touch
 * a `data/` directory, validate the manifest, bundle the integration module
 * from ../../src/integration (third parties would import a published
 * package instead — the contract and reader are identical either way). */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist");

function fail(message) {
  throw new Error(message);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (manifest.apiVersion !== 1) fail("Manifest apiVersion must be 1.");
if (!manifest.main || !manifest.backend) fail("The demo expects both a main and backend entry.");

const dist = fs.lstatSync(output, { throwIfNoEntry: false });
if (dist?.isSymbolicLink()) fail("Refusing to build into a symlinked dist directory.");
if (fs.lstatSync(path.join(output, "data"), { throwIfNoEntry: false })) {
  fail("Refusing to build over dist/data; plugin data must live beside dist.");
}
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

const common = {
  absWorkingDir: root,
  bundle: true,
  target: "es2022",
  minify: false, // keep the demo readable for anyone diffing it
  legalComments: "eof",
  logLevel: "warning",
};

await build({
  ...common,
  entryPoints: [path.join(root, "src", "backend.ts")],
  outfile: path.join(output, "backend.cjs"),
  format: "cjs",
  platform: "node",
  external: ["node:*"],
});
await build({
  ...common,
  entryPoints: [path.join(root, "src", "main.ts")],
  outfile: path.join(output, "main.js"),
  format: "esm",
  platform: "browser",
});

fs.copyFileSync(path.join(root, "manifest.json"), path.join(output, "manifest.json"));

for (const entry of ["backend.cjs", "main.js", "manifest.json"]) {
  if (!fs.lstatSync(path.join(output, entry), { throwIfNoEntry: false })?.isFile()) {
    fail(`Missing build output: ${entry}`);
  }
}

console.log(`Built the Learning Path companion demo into ${output}`);
