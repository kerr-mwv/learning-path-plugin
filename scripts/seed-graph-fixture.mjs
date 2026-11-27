#!/usr/bin/env node
/**
 * Seed (or remove) the synthetic Velora knowledge-graph fixture.
 *
 * The fixture is a small, self-contained set of graph ledgers in the host's
 * on-disk format. It exercises:
 *   - the native graph view (9 propositions, 5 argument chains, one imported
 *     notes source and one derived-cluster label), and
 *   - the Learning Path graph-informed tutoring branch, whose retrieval reads
 *     `ctx.learning.graph().propositions` and matches a path node's title,
 *     goal and source anchor against statements and aliases.
 *
 * Nothing here writes a chat, transcript or model output. The data is invented.
 *
 * Examples:
 *   node scripts/seed-graph-fixture.mjs --data-dir <dev-data-dir> --dry-run
 *   node scripts/seed-graph-fixture.mjs --data-dir <dev-data-dir> --with-path
 *   node scripts/seed-graph-fixture.mjs --data-dir <dev-data-dir> --remove
 *
 * `--data-dir` is the LearnHarness data directory (the one containing
 * `graph/` and `plugins/`). It must be given explicitly: the script never
 * guesses, and it refuses to seed the OS-default real data directory
 * (e.g. `~/.config/LearnHarness/data`) unless `--allow-real-data` is also
 * passed. Point it at a scratch/dev copy instead.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(REPO, "fixtures/velora");
const SOURCE_ID = "src_velora01";
const PATH_ID = "path-velora-beads";

function usage() {
  console.log(`Usage: node scripts/seed-graph-fixture.mjs [options]

Options:
  --data-dir <dir>        LearnHarness data directory (contains graph/ and plugins/).
                          Required: no default. Seeding the OS-default real data
                          directory additionally needs --allow-real-data.
  --plugin-data-dir <dir> Learning Path plugin data directory
                          (default: <data-dir>/plugins/learning-path/data)
  --with-path             Also install the synthetic Velora learning path
  --force                 Overwrite differing records instead of skipping them
  --dry-run               Show what would change without writing
  --remove                Remove the fixture records again (backup first)
  --allow-real-data       Permit seeding the OS-default real data directory
  --help                  Show this help

Seeding appends missing ledger lines and preserves every existing record.
--remove is fixture-scoped and never needs --allow-real-data.`);
}

function fail(message) {
  console.error(`seed-graph-fixture: ${message}`);
  process.exitCode = 1;
}

function defaultDataDir() {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library/Application Support/LearnHarness/data");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData/Roaming"), "LearnHarness/data");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "LearnHarness/data");
}

function parseArgs(argv) {
  const args = { withPath: false, force: false, dryRun: false, remove: false, allowRealData: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const next = () => {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === "--data-dir") args.dataDir = next();
    else if (arg === "--plugin-data-dir") args.pluginDataDir = next();
    else if (arg === "--with-path") args.withPath = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--remove") args.remove = true;
    else if (arg === "--allow-real-data") args.allowRealData = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  return args;
}

const exists = file => fs.existsSync(file);
const isRecord = value => typeof value === "object" && value !== null && !Array.isArray(value);

function readJson(file) {
  if (!exists(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`refusing to touch corrupt JSON at ${file}`);
  }
}

/** Existing ledgers are append-only. Unparseable lines are left untouched. */
function readJsonlLoose(file) {
  if (!exists(file)) return [];
  const records = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { /* leave the corrupt line alone */ }
  }
  return records;
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

function missingJsonl(file, records, keyOf) {
  const present = new Set(readJsonlLoose(file).map(keyOf));
  return records.filter(record => !present.has(keyOf(record)));
}

function appendMissingJsonl(file, records, keyOf, label, dryRun) {
  const current = readJsonlLoose(file);
  const byKey = new Map();
  for (const record of current) {
    try { byKey.set(keyOf(record), record); } catch { /* shape is the host's problem */ }
  }
  const missing = records.filter(record => !byKey.has(keyOf(record)));
  for (const record of records) {
    const present = byKey.get(keyOf(record));
    if (present && JSON.stringify(present) !== JSON.stringify(record)) {
      console.warn(`warning: ${label} ${keyOf(record)} already exists with different content; keeping the existing line`);
    }
  }
  if (dryRun) {
    console.log(`[dry-run] would append ${missing.length} ${label} line(s) to ${file}`);
    return missing.length;
  }
  if (missing.length > 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (exists(file) && fs.statSync(file).size > 0) {
      const text = fs.readFileSync(file, "utf8");
      if (!text.endsWith("\n")) fs.appendFileSync(file, "\n");
    }
    fs.appendFileSync(file, missing.map(record => JSON.stringify(record)).join("\n") + "\n");
  }
  console.log(`appended ${missing.length} ${label} line(s) to ${file}`);
  return missing.length;
}

function backupFiles(dataDir, files, dryRun = false) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const destination = path.join(dataDir, "backups", `velora-seed-${stamp}`);
  let copied = 0;
  for (const file of files) {
    if (!exists(file)) continue;
    if (dryRun) {
      copied++;
      continue;
    }
    const relative = path.relative(dataDir, file);
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(file, target);
    copied++;
  }
  if (copied === 0) return null;
  console.log(dryRun ? `[dry-run] would back up to ${destination}` : `backup: ${destination}`);
  return destination;
}

function loadFixture() {
  const nodes = readJsonlLoose(path.join(FIXTURE, "graph/nodes.jsonl"));
  const chains = readJsonlLoose(path.join(FIXTURE, "graph/chains.jsonl"));
  const checkpoints = readJsonlLoose(path.join(FIXTURE, "graph/sessions.jsonl"));
  const sourceMap = readJson(path.join(FIXTURE, "graph/sources.json"));
  const pathRecord = readJson(path.join(FIXTURE, "path", `${PATH_ID}.json`));
  if (!isRecord(sourceMap) || !isRecord(sourceMap[SOURCE_ID])) throw new Error("fixture sources.json is missing its source record");
  if (!Array.isArray(nodes) || nodes.length === 0) throw new Error("fixture nodes.jsonl is empty");
  if (!Array.isArray(chains)) throw new Error("fixture chains.jsonl is invalid");
  if (!Array.isArray(checkpoints)) throw new Error("fixture sessions.jsonl is invalid");
  if (!isRecord(pathRecord) || !isRecord(pathRecord.path) || pathRecord.path.id !== PATH_ID) throw new Error("fixture path record is invalid");

  const nodeIds = new Set(nodes.map(node => node.id));
  if (nodeIds.size !== nodes.length) throw new Error("fixture node ids are not unique");
  for (const chain of chains) {
    for (const endpoint of [chain.conclusion, ...chain.premises]) {
      if (!nodeIds.has(endpoint)) throw new Error(`fixture chain ${chain.id} points at unknown node ${endpoint}`);
    }
  }
  for (const node of nodes) {
    for (const point of node.provenance ?? []) {
      if (point.chatId !== SOURCE_ID) throw new Error(`fixture node ${node.id} has unexpected provenance ${point.chatId}`);
    }
  }
  for (const chain of chains) {
    for (const point of chain.provenance ?? []) {
      if (point.chatId !== SOURCE_ID) throw new Error(`fixture chain ${chain.id} has unexpected provenance ${point.chatId}`);
    }
  }

  const source = { ...sourceMap[SOURCE_ID], filePath: path.join(FIXTURE, "velora-bead-system.md") };
  return { nodes, chains, checkpoints, source, pathRecord, nodeIds };
}

function seed({ dataDir, pluginDataDir, withPath, force, dryRun, fixture }) {
  const graphDir = path.join(dataDir, "graph");
  const nodesFile = path.join(graphDir, "nodes.jsonl");
  const chainsFile = path.join(graphDir, "chains.jsonl");
  const sessionsFile = path.join(graphDir, "sessions.jsonl");
  const sourcesFile = path.join(graphDir, "sources.json");
  const formatFile = path.join(graphDir, "format.json");
  const pathFile = path.join(pluginDataDir, "paths", `${PATH_ID}.json`);

  const format = readJson(formatFile);
  if (format !== undefined && (!isRecord(format) || format.version !== 1)) {
    throw new Error(`${formatFile} has an unsupported graph format; refusing to seed`);
  }
  const sources = readJson(sourcesFile) ?? {};
  if (!isRecord(sources)) throw new Error(`${sourcesFile} is not a JSON object; refusing to seed`);

  const missingNodes = missingJsonl(nodesFile, fixture.nodes, node => node.id);
  const missingChains = missingJsonl(chainsFile, fixture.chains, chain => chain.id);
  const missingCheckpoints = missingJsonl(sessionsFile, fixture.checkpoints, checkpoint => checkpoint.chatId);
  const currentSource = sources[SOURCE_ID];
  const currentPath = exists(pathFile) ? readJson(pathFile) : undefined;
  const pathDiffers = withPath && currentPath !== undefined && JSON.stringify(currentPath) !== JSON.stringify(fixture.pathRecord);
  const sourceDiffers = currentSource !== undefined && JSON.stringify(currentSource) !== JSON.stringify(fixture.source);
  const changes = format === undefined || missingNodes.length + missingChains.length + missingCheckpoints.length > 0
    || currentSource === undefined || (withPath && currentPath === undefined) || (force && (sourceDiffers || pathDiffers));
  if (!changes) {
    console.log("already seeded; nothing to do");
    return;
  }

  backupFiles(dataDir, [nodesFile, chainsFile, sessionsFile, sourcesFile, formatFile, pathFile], dryRun);

  if (format === undefined) {
    if (dryRun) console.log(`[dry-run] would create ${formatFile} with {"version": 1}`);
    else {
      atomicWrite(formatFile, JSON.stringify({ version: 1 }, null, "\t") + "\n");
      console.log(`created ${formatFile}`);
    }
  }

  appendMissingJsonl(nodesFile, fixture.nodes, node => node.id, "node", dryRun);
  appendMissingJsonl(chainsFile, fixture.chains, chain => chain.id, "chain", dryRun);
  appendMissingJsonl(sessionsFile, fixture.checkpoints, checkpoint => checkpoint.chatId, "session checkpoint", dryRun);

  if (currentSource && JSON.stringify(currentSource) !== JSON.stringify(fixture.source)) {
    if (force && !dryRun) {
      sources[SOURCE_ID] = fixture.source;
      atomicWrite(sourcesFile, JSON.stringify(sources, null, "\t") + "\n");
      console.log(`replaced source ${SOURCE_ID} in ${sourcesFile}`);
    } else if (force) {
      console.log(`[dry-run] would replace source ${SOURCE_ID}`);
    } else {
      console.warn(`warning: source ${SOURCE_ID} already exists with different content; keeping the existing record (use --force to overwrite)`);
    }
  } else if (!currentSource) {
    if (dryRun) console.log(`[dry-run] would add source ${SOURCE_ID} to ${sourcesFile}`);
    else {
      sources[SOURCE_ID] = fixture.source;
      atomicWrite(sourcesFile, JSON.stringify(sources, null, "\t") + "\n");
      console.log(`added source ${SOURCE_ID} to ${sourcesFile}`);
    }
  }

  if (withPath) {
    if (exists(pathFile)) {
      const existing = readJson(pathFile);
      if (JSON.stringify(existing) !== JSON.stringify(fixture.pathRecord)) {
        if (force && !dryRun) {
          atomicWrite(pathFile, JSON.stringify(fixture.pathRecord, null, 2) + "\n");
          console.log(`replaced path ${PATH_ID} at ${pathFile}`);
        } else if (force) {
          console.log(`[dry-run] would replace ${pathFile}`);
        } else {
          console.warn(`warning: ${pathFile} already exists with different content; keeping it (use --force to overwrite)`);
        }
      } else {
        console.log(`path already installed at ${pathFile}`);
      }
    } else if (dryRun) {
      console.log(`[dry-run] would write ${pathFile}`);
    } else {
      atomicWrite(pathFile, JSON.stringify(fixture.pathRecord, null, 2) + "\n");
      console.log(`installed path ${PATH_ID} at ${pathFile}`);
    }
  }

  console.log(`\nseeded ${fixture.nodes.length} propositions and ${fixture.chains.length} chains from ${SOURCE_ID}`);
  console.log(`note: graph-informed tutoring reads this data only when`);
  console.log(`      Settings -> Learning Paths -> "Use graph context for teaching and practice" is on.`);
}

function remove({ dataDir, pluginDataDir, force, dryRun, fixture }) {
  const graphDir = path.join(dataDir, "graph");
  const files = {
    nodes: path.join(graphDir, "nodes.jsonl"),
    chains: path.join(graphDir, "chains.jsonl"),
    sessions: path.join(graphDir, "sessions.jsonl"),
    sources: path.join(graphDir, "sources.json"),
  };
  const pathFile = path.join(pluginDataDir, "paths", `${PATH_ID}.json`);
  backupFiles(dataDir, [...Object.values(files), pathFile], dryRun);

  const removable = record => {
    if (!fixture.nodeIds.has(record.id) && !fixture.chains.some(chain => chain.id === record.id)) return false;
    const points = Array.isArray(record.provenance) ? record.provenance : [];
    return force || points.every(point => point?.chatId === SOURCE_ID);
  };
  const keepCounts = {};
  for (const [name, file] of [["nodes", files.nodes], ["chains", files.chains]]) {
    const records = readJsonlLoose(file);
    const next = records.filter(record => {
      const drop = removable(record);
      if (!drop && fixture.nodeIds.has(record.id)) {
        console.warn(`warning: keeping ${record.id}: it now has provenance outside the fixture (use --force to remove)`);
      }
      return !drop;
    });
    const removed = records.length - next.length;
    keepCounts[name] = removed;
    if (removed === 0) continue;
    if (dryRun) console.log(`[dry-run] would rewrite ${file} without ${removed} fixture line(s)`);
    else {
      atomicWrite(file, next.map(record => JSON.stringify(record)).join("\n") + (next.length ? "\n" : ""));
      console.log(`removed ${removed} ${name} line(s) from ${file}`);
    }
  }

  const checkpoints = readJsonlLoose(files.sessions);
  const keptCheckpoints = checkpoints.filter(checkpoint => checkpoint.chatId !== SOURCE_ID);
  if (keptCheckpoints.length !== checkpoints.length) {
    if (dryRun) console.log(`[dry-run] would remove ${checkpoints.length - keptCheckpoints.length} session checkpoint(s)`);
    else {
      atomicWrite(files.sessions, keptCheckpoints.map(record => JSON.stringify(record)).join("\n") + (keptCheckpoints.length ? "\n" : ""));
      console.log(`removed ${checkpoints.length - keptCheckpoints.length} session checkpoint(s)`);
    }
  }

  const sources = readJson(files.sources) ?? {};
  if (isRecord(sources) && sources[SOURCE_ID]) {
    if (dryRun) console.log(`[dry-run] would remove source ${SOURCE_ID}`);
    else {
      delete sources[SOURCE_ID];
      atomicWrite(files.sources, JSON.stringify(sources, null, "\t") + "\n");
      console.log(`removed source ${SOURCE_ID}`);
    }
  }

  if (exists(pathFile)) {
    const existing = readJson(pathFile);
    if (JSON.stringify(existing) !== JSON.stringify(fixture.pathRecord) && !force) {
      console.warn(`warning: keeping ${pathFile}: it has been edited or linked since seeding (use --force to remove)`);
    } else if (dryRun) {
      console.log(`[dry-run] would remove ${pathFile}`);
    } else {
      fs.rmSync(pathFile);
      console.log(`removed ${pathFile}`);
    }
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
  } else {
    if (!args.dataDir) throw new Error("--data-dir is required; the script never guesses a data directory. Point it at a dev/scratch copy (or pass the real directory together with --allow-real-data)");
    const dataDir = path.resolve(args.dataDir);
    const pluginDataDir = path.resolve(args.pluginDataDir ?? path.join(dataDir, "plugins/learning-path/data"));
    if (!exists(dataDir)) throw new Error(`data directory does not exist: ${dataDir}`);
    if (!args.remove && !args.allowRealData && path.resolve(defaultDataDir()) === dataDir) {
      throw new Error(`${dataDir} is the OS-default real LearnHarness data directory; refusing to seed real data without --allow-real-data. Prefer a dev/scratch copy, or run with --remove to clean up a previous seed.`);
    }
    const fixture = loadFixture();
    console.log(`${args.remove ? "removing" : "seeding"} Velora fixture in ${dataDir}${args.dryRun ? " (dry run)" : ""}`);
    if (args.remove) remove({ dataDir, pluginDataDir, force: args.force, dryRun: args.dryRun, fixture });
    else seed({ dataDir, pluginDataDir, withPath: args.withPath, force: args.force, dryRun: args.dryRun, fixture });
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
