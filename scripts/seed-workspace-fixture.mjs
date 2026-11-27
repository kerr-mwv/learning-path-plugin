#!/usr/bin/env node
/**
 * Seed (or remove) a synthetic workspace fixture: one demo path plus a
 * workspace holding a representative item of every v1 kind.
 *
 * The fixture is invented and self-contained. It writes through the real
 * store (`src/store.ts`), so every record it leaves behind has passed the
 * same validators the app uses — what you see on disk after seeding is
 * exactly what a live workspace looks like:
 *
 *   workspaces/<pathId>/manifest.json    the ledger (an index, never content)
 *   workspaces/<pathId>/files/<uuid>.md  item content, UUID names
 *
 * Items seeded, one per relationship:
 *   - a learner note written "in a text editor", linked `informs` a node
 *   - a session-produced relational map, linked `produced_by` a node
 *   - a session-produced code artifact, linked `produced_by` another node
 *   - a converted document that enters the global `sources/` store and is
 *     *referenced* by a `source` workspace item linked `grounds` a node
 *   - a workspace-level note linked to "space"
 *
 * Examples:
 *   node scripts/seed-workspace-fixture.mjs --data-dir <dev-data-dir>
 *   node scripts/seed-workspace-fixture.mjs --data-dir <dev-data-dir> --dry-run
 *   node scripts/seed-workspace-fixture.mjs --data-dir <dev-data-dir> --remove
 *
 * `--data-dir` is the LearnHarness data directory (the one containing
 * `plugins/`). It must be given explicitly: the script never guesses, and it
 * refuses to seed the OS-default real data directory unless `--allow-real-data`
 * is also passed. Point it at a scratch/dev copy instead.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openLearningPathStore } from "../src/store.ts";

const PATH_ID = "path-consensus-demo";
const SOURCE_NAME = "consensus-reading-digest.md";
const AT = () => new Date().toISOString();

const DEMO_PATH = {
  id: PATH_ID,
  title: "Consensus under partial failure",
  goal: "Reason about replication and agreement from first principles, and implement a small election.",
  createdAt: AT(),
  updatedAt: AT(),
  sourceSpine: {
    mode: "canonical",
    references: [{ title: "A Distributed Systems Reader", author: "A. Author", edition: "1.0", kind: "textbook" }],
  },
  modules: [
    {
      id: "module-foundations",
      title: "Foundations",
      goal: "Build the map and the vocabulary before any algorithm.",
      nodes: [
        {
          id: "n-map",
          type: "holistic",
          title: "The consensus landscape",
          goal: "Place the consensus families and say what problem each solves.",
          sourceAnchor: { reference: "A Distributed Systems Reader", chapter: "5" },
          interleavesNodeIds: [],
          progression: "consolidated",
          childSessions: [],
          errors: [],
          pivotSuggestions: [],
        },
        {
          id: "n-quorum",
          type: "concept",
          title: "Quorums and overlap",
          goal: "Explain why overlapping quorums keep replicated state converging.",
          sourceAnchor: { reference: "A Distributed Systems Reader", chapter: "5", section: "5.2", pages: "140-155" },
          interleavesNodeIds: ["n-map"],
          progression: "in_progress",
          artifactConfig: { type: "relational_map" },
          childSessions: [],
          errors: [],
          pivotSuggestions: [],
        },
        {
          id: "n-failure",
          type: "contrast",
          title: "Crash vs Byzantine failure",
          goal: "Discriminate the two failure models and what each demands of a protocol.",
          sourceAnchor: { reference: "A Distributed Systems Reader", chapter: "6", section: "6.1" },
          interleavesNodeIds: ["n-map"],
          progression: "unstarted",
          childSessions: [],
          errors: [],
          pivotSuggestions: [],
        },
      ],
    },
    {
      id: "module-practice",
      title: "Practice",
      goal: "Turn the vocabulary into working behavior.",
      nodes: [
        {
          id: "n-election",
          type: "skill",
          title: "Leader election in code",
          goal: "Implement a term-based election and reason about split votes.",
          sourceAnchor: { reference: "A Distributed Systems Reader", chapter: "7", section: "7.3", pages: "201-218" },
          interleavesNodeIds: ["n-quorum"],
          progression: "in_progress",
          artifactConfig: { type: "micro_code", instructions: "Smallest election that can lose a candidate." },
          childSessions: [],
          errors: [],
          pivotSuggestions: [],
        },
        {
          id: "n-checkpoint",
          type: "checkpoint",
          title: "Integrative checkpoint",
          goal: "Diagnose an election failure without being told which concept applies.",
          sourceAnchor: { reference: "A Distributed Systems Reader", chapter: "5-7" },
          interleavesNodeIds: ["n-map", "n-quorum", "n-election"],
          progression: "unstarted",
          childSessions: [],
          errors: [],
          pivotSuggestions: [],
        },
      ],
    },
  ],
};

const NOTE_QUORUM = `# Quorum intuition — my own words

Written in my editor beside LearnHarness, pasted in verbatim.

A quorum is not "most machines agree". It is an *overlap guarantee*:
any two majorities must share at least one replica, so a stale read
cannot hide behind a fresh write.

Still open for me:
- why does R + W > N feel stronger than majority-majority, and when
  does the difference actually bite?
`;

const MAP_ARTIFACT = `# Relational map: the consensus landscape

Drawn in the teaching session for "The consensus landscape".

- Paxos family — proposers / accepters / learners; the ballot is the unit of agreement
  - Raft — strong leader + terms; chosen for understandability, not novelty
  - Viewstamped Replication — primary/backup lineage; the older sibling
- Quorum engine underneath all of them — overlap, not counting
- Failure model picks the armor: crash-stop needs timeouts; Byzantine needs
  signatures and 3f+1

Link I could not label honestly yet: where exactly a "term" ends and a
"ballot" begins in the read path.
`;

const ELECTION_CODE = `// Term-based election, micro version (produced in the practice session).
// Invented for the fixture; small on purpose so the failure case is visible.

function elect(term, peers) {
  const votes = peers.filter((p) => p.logLength() >= this.logLength() || p.term() > term);
  return votes.length + 1 > (peers.length + 1) / 2;
}
// Failure case worth keeping: a candidate with a *shorter* log can still win
// a term — the guard above is about liveness, not freshness.
`;

const NOTE_SPACE = `# Open questions

Workspace-level: not tied to one node yet.

- Does the checkpoint expect me to *derive* the 3f+1 bound or just apply it?
- Revisit the quorum R+W question after the contrast node.
`;

const SOURCE_MARKDOWN = `# Consensus reading digest

A converted document (as if uploaded from a PDF), stored once in the global
sources/ store and *referenced* by the workspace — the ledger references,
never copies.

## Chapter 5 — Replication and quorums

Majority quorums give read/write overlap: any two majorities intersect, so
concurrent operations cannot both claim the last word without meeting.

## Chapter 7 — Elections

Terms bound disagreement in time; a higher term silences lower-term talkers.
`;

function usage() {
  console.log(`Usage: node scripts/seed-workspace-fixture.mjs [options]

Options:
  --data-dir <dir>        LearnHarness data directory (contains plugins/).
                          Required: no default. Seeding the OS-default real data
                          directory additionally needs --allow-real-data.
  --plugin-data-dir <dir> Learning Path plugin data directory
                          (default: <data-dir>/plugins/learning-path/data)
  --force                 Replace an existing demo path and its workspace
  --dry-run               Print the plan without writing anything
  --remove                Remove the demo path (its workspace goes with it,
                          because deleting a path is one learner decision) and
                          the demo source. Never needs --allow-real-data.
  --allow-real-data       Permit seeding the OS-default real data directory
  --help                  Show this help

Removing the demo path also exercises the rule that only paths.delete
removes a workspace.`);
}

function fail(message) {
  console.error(`seed-workspace-fixture: ${message}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = { dataDir: null, pluginDataDir: null, force: false, dryRun: false, remove: false, allowRealData: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--data-dir") args.dataDir = argv[++i] ?? null;
    else if (arg === "--plugin-data-dir") args.pluginDataDir = argv[++i] ?? null;
    else if (arg === "--force") args.force = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--remove") args.remove = true;
    else if (arg === "--allow-real-data") args.allowRealData = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else {
      fail(`unknown argument: ${arg}`);
      args.help = true;
    }
  }
  return args;
}

function defaultDataDir() {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library/Application Support/LearnHarness/data");
  if (process.platform === "win32") return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData/Roaming"), "LearnHarness/data");
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "LearnHarness/data");
}

function exists(candidate) {
  try {
    fs.statSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function printTree(root, prefix = "") {
  const entries = fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  entries.forEach((entry, index) => {
    const last = index === entries.length - 1;
    const line = `${prefix}${last ? "└── " : "├── "}${entry.name}`;
    const size = entry.isDirectory() ? "" : `  (${fs.statSync(path.join(root, entry.name)).size} bytes)`;
    console.log(`${line}${size}`);
    if (entry.isDirectory()) printTree(path.join(root, entry.name), `${prefix}${last ? "    " : "│   "}`);
  });
}

function seed({ pluginDataDir, force, dryRun }) {
  const store = openLearningPathStore(pluginDataDir);
  if (store.path(PATH_ID) && !force) {
    throw new Error(
      `demo path "${PATH_ID}" already exists; pass --force to replace it, or --remove to clean up a previous seed`,
    );
  }
  const plan = [
    `path record    paths/${PATH_ID}.json`,
    `workspace dir  workspaces/${PATH_ID}/ (materializes on the first item below)`,
    `  note            "Quorum intuition — my own words"        informs     n-quorum`,
    `  session_artifact "Relational map: consensus landscape"    produced_by n-map`,
    `  code            "Term-based election, micro version"      produced_by n-election`,
    `  source          "Consensus reading digest" (global sources/, referenced) grounds n-quorum`,
    `  note            "Open questions"                          informs     space`,
  ];
  console.log(`Seeding the demo workspace in ${pluginDataDir}${dryRun ? " (dry run)" : ""}`);
  plan.forEach((line) => console.log(`  ${line}`));
  if (dryRun) return;

  if (store.path(PATH_ID)) store.deletePath(PATH_ID);
  store.savePath(DEMO_PATH);
  store.saveWorkspaceItem(PATH_ID, { kind: "note", title: "Quorum intuition — my own words", addedBy: "learner", links: [{ to: "n-quorum", rel: "informs" }] }, NOTE_QUORUM);
  store.saveWorkspaceItem(PATH_ID, { kind: "session_artifact", title: "Relational map: consensus landscape", addedBy: "session:chat-demo-teaching", links: [{ to: "n-map", rel: "produced_by" }] }, MAP_ARTIFACT);
  store.saveWorkspaceItem(PATH_ID, { kind: "code", title: "Term-based election, micro version", addedBy: "session:chat-demo-practice", links: [{ to: "n-election", rel: "produced_by" }] }, ELECTION_CODE);
  const saved = store.saveSource({ name: SOURCE_NAME, markdown: SOURCE_MARKDOWN });
  store.saveWorkspaceItem(PATH_ID, { kind: "source", title: "Consensus reading digest", addedBy: "learner", sourceId: saved.reference.sourceId, links: [{ to: "n-quorum", rel: "grounds" }] });
  store.saveWorkspaceItem(PATH_ID, { kind: "note", title: "Open questions", addedBy: "learner", links: [{ to: "space", rel: "informs" }] }, NOTE_SPACE);

  const workspaceDirectory = path.join(pluginDataDir, "workspaces", PATH_ID);
  console.log("");
  console.log(`Workspace on disk (${workspaceDirectory}):`);
  printTree(workspaceDirectory);
  console.log("");
  console.log("manifest.json — the ledger:");
  console.log(JSON.stringify(store.workspace(PATH_ID), null, 2));
}

function remove({ pluginDataDir, dryRun }) {
  const store = openLearningPathStore(pluginDataDir);
  if (!exists(pluginDataDir)) throw new Error(`data directory does not exist: ${pluginDataDir}`);
  const demo = store.path(PATH_ID);
  const source = store.sources().find((candidate) => candidate.name === SOURCE_NAME);
  console.log(`Removing the demo path${demo ? " (its workspace goes with it)" : " (not present)"}${dryRun ? " (dry run)" : ""}`);
  if (dryRun) return;
  if (demo) {
    store.deletePath(PATH_ID);
    console.log(`removed paths/${PATH_ID}.json and workspaces/${PATH_ID}/`);
  }
  if (source) {
    store.removeSource(source.sourceId);
    console.log(`removed sources/${source.sourceId}.md (${SOURCE_NAME})`);
  }
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
  } else {
    if (!args.dataDir && !args.pluginDataDir) {
      throw new Error("--data-dir (or --plugin-data-dir) is required; the script never guesses a data directory. Point it at a dev/scratch copy (or pass the real directory together with --allow-real-data)");
    }
    const dataDir = path.resolve(args.dataDir || args.pluginDataDir);
    const pluginDataDir = path.resolve(args.pluginDataDir ?? path.join(dataDir, "plugins/learning-path/data"));
    if (!exists(args.dataDir ? dataDir : pluginDataDir)) {
      throw new Error(`data directory does not exist: ${args.dataDir ? dataDir : pluginDataDir}`);
    }
    if (!args.remove && !args.allowRealData && path.resolve(defaultDataDir()) === pluginDataDir) {
      throw new Error(`${pluginDataDir} is inside the OS-default real LearnHarness data directory; refusing to seed real data without --allow-real-data. Prefer a dev/scratch copy, or run with --remove to clean up a previous seed.`);
    }
    if (args.remove) remove({ pluginDataDir, dryRun: args.dryRun });
    else seed({ pluginDataDir, force: args.force, dryRun: args.dryRun });
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
