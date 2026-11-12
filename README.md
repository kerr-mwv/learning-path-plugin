# Learning Paths — LearnHarness plugin

Build and follow a pedagogical learning path on a textbook, course or
uploaded corpus. A persistent **Path Architect** conversation designs the path;
each node opens native **Teaching** and **Practice** child chats that report
progression, errors and advisory pivots back to the path.

This is a LearnHarness Community plugin (`apiVersion: 1`, id `learning-path`,
`minAppVersion 0.6.0`).

## The framework

Most self-directed study fails in one of two ways: unstructured wandering
between disconnected tutorials and chats, or an LLM-generated syllabus that
invents its sequence, skips prerequisites and mistakes reading explanations for
understanding. This plugin separates the **path** (curriculum architecture,
grounded in a real source) from the **sessions** (first-principles teaching and
practice), and connects them with a light diagnostic loop. Every Architect and
child-chat prompt follows seven principles:

1. **Canonical source grounding.** Every path is anchored to a source spine:
   1–2 reputable textbooks, courses or specifications, or a book you upload.
   Every node carries a chapter/section anchor. No invented curricula.
2. **A proactive six-type node taxonomy.** `holistic`, `concept`, `contrast`,
   `skill`, `checkpoint` and `bridge` nodes (see [Node taxonomy](#node-taxonomy)).
   Structural maps and contrasts are built into the baseline path, before
   confusion sets in, not only after a failure.
3. **Advisory-only adaptation.** The path never rewrites itself. When a topic
   genuinely is not sticking, an agent proposes a bounded pivot (a bridge,
   contrast or skill node) with its diagnosis; you accept, discuss or dismiss it.
4. **Light pre-reading and loose priming.** Nodes point to a short skim before
   deep study, and a session may open with a motivating puzzle. Never a gate.
5. **Interleaving at three scales.** Variations within a session, earlier nodes
   pulled into later ones, and integrative checkpoints across modules that do
   not name the tools they need.
6. **Generative artifacts with stated reasons.** Producing a micro-program,
   relational map, blank-page encoding, derivation or retrieval cue beats
   nodding along in chat. Artifacts are configurable, and the UI always says why
   one is recommended.
7. **Ungated progression, zero scheduling.** `unstarted → in_progress →
   consolidated`, any node at any time, no hours, streaks or dates. Mistakes are
   logged by cognitive root cause and travel forward as watchpoints.

[`FRAMEWORK.md`](./FRAMEWORK.md) gives the full rationale for each principle and
a glossary of every term the plugin uses.

## Installation

### Download a release (no build tools needed)

Requirements: LearnHarness 0.6.0 or later.

1. Download `learning-path-<version>.zip` from the
   [latest release](https://github.com/kerr-mwv/learning-path-plugin/releases/latest).
2. Open **Settings → Community plugins** in LearnHarness to find your plugins
   directory.
3. Unzip the archive into that directory. It contains `learning-path/dist/`, so
   you end up with `<plugins-directory>/learning-path/dist/manifest.json`.
4. Refresh Community plugins and enable **Learning Paths**.

To update, delete `learning-path/dist/` and unzip the new release in its place.
Never delete `learning-path/data/`: it holds your paths and settings. Restart
LearnHarness to load the new version.

### Build from source

Requirements: LearnHarness 0.6.0 or later, Node.js 24 and npm.

```sh
git clone https://github.com/kerr-mwv/learning-path-plugin.git
cd learning-path-plugin
npm ci
npm run build              # bundles dist/ only
npm run install:local -- "<plugins-directory>"
```

`<plugins-directory>` is the path shown in **Settings → Community plugins**.
The command builds first, then installs to
`<plugins-directory>/learning-path/dist/`:

```text
learning-path/
  dist/
    manifest.json
    main.js        # browser ES module
    backend.cjs    # Node CommonJS, built-ins external
    styles.css
  data/            # persistent, host-owned; never distributed
```

Refresh Community plugins after a first install and enable **Learning Paths**.
Restart LearnHarness to load updated code into an already-running app.

### Updating safely

`install:local` replaces only the installed `dist/` directory and preserves the
sibling `data/` directory, source files and enablement choices. It stages the
complete replacement before moving the old `dist/` aside and restores it if the
replacement fails. It refuses symlinked roots/entries, an already-present
`dist/data/`, and non-distributable `data/`, `node_modules/`, `.git/` or
credential files inside the package.

The build writes only `dist/`. It refuses a symlinked `dist/` and a misplaced
`dist/data/`, and never touches a sibling `data/` directory. At runtime the
plugin writes through the host-provided `ctx.dataDirectory`:
`learning-paths.json`, `settings.json`, `architect.json` and `sources/`. It leaves
host-reserved `agents/`, `tasks/` and `usage.jsonl` alone, refuses newer or
corrupt records instead of wiping them, and never deletes native chats or
Knowledge Graph records.

## Workflow

1. **Create a Path.** Open the Path Hub, choose an Architect model and optional
   thinking level in the composer (or leave it on the configured default), then
   send your first message. The conversation is created on send, so the model
   choice is applied before the Architect starts. All Architect conversations share
   one model: choosing a different one in **Create a Path** switches it for every
   conversation's later messages, and is refused while an Architect run is in progress. Give it a goal and your background. A source is optional: the Architect can choose reputable
   primary references, or you can name one or upload a PDF/UTF-8 book converted locally
   to Markdown. For uploads, it uses the contents and chapter structure to align nodes
   with reading, rather than requiring a full-book read before drafting. For new paths,
   the Architect supplies a short semantic draft; the plugin builds IDs, timestamps,
   progression, empty state lists and interleaving before validation. To refine, the
   Architect reads the current outline and its ids with `get_learning_path`; progress,
   child chats, errors and pivots already recorded on existing nodes are never
   overwritten by a draft. Large drafts can use a single JSON-string tool argument if
   nested tool arguments fail to serialize.
   The Architect
   shows streaming text, tool activity and reasoning when the model exposes it.
   Set `LEARNING_PATH_DEBUG=1` in the LearnHarness backend environment for
   metadata-only Architect lifecycle logs (no prompts or uploaded text). The Architect proposes
   modules and typed nodes with chapter/section anchors.
2. **Follow the tree.** Modules → nodes → child chats. Select a node to see its
   goal, canonical anchor, light pre-reading pointer, interleaved prior nodes,
   artifact recommendation, progression and error watchpoints.
3. **Study in child chats.** *Start Teaching Chat* or *Start Practice Chat*
   creates a native session, stages a tailored opening brief and opens it. Linked
   sessions get `learning_path_*` tools that read the brief and write progress,
   errors and advisory pivots. Unlinked sessions get no tools at all.
4. **Record what happened.** Progression is ungated:
   `unstarted → in_progress → consolidated`. Log mistakes by cognitive root
   cause; unresolved entries travel forward as watchpoints. If a topic genuinely
   is not sticking, the agent may suggest a bounded detour; you accept, discuss
   or dismiss it. The path is never restructured silently.
5. **Tune defaults.** Settings → Learning Paths configures artifact defaults per
   node type (with the framework's justification), the Architect model/thinking
   preference, and safe path deletion. Saving a new Architect model while an
   Architect run is in progress never cancels it; the model applies once the run
   finishes.

There is deliberately **no scheduling**: no hours, days, streaks or completion
dates. Any node can be opened at any time.

## Node taxonomy

| Type | Purpose | Typical artifact |
| --- | --- | --- |
| `holistic` | Structural map: how the ideas in a module fit together | Relational map / diagram |
| `concept` | One load-bearing idea from first principles | Micro-code, encoding exercise, derivation trace |
| `contrast` | Explicit boundary between confusable ideas | Relational map, compare/contrast matrix |
| `skill` | Brief procedural fluency, idiom or heuristic | Micro-code, derivation trace, retrieval cue |
| `checkpoint` | Mixed synthesis problems with no topic labels | Micro-code or derivation trace |
| `bridge` | Bounded repair of one missing prerequisite | Whatever fits the gap; keep it short |

`holistic` and `contrast` nodes are placed proactively in the baseline path, not
only after a learner fails.

## Artifacts

Reading an explanation creates an illusion of competence; producing an artifact
forces retrieval. Artifacts are configurable globally, per path and per node,
including conversation-only (`none`). The UI always shows why a type is
recommended.

| Type | Best for | Why |
| --- | --- | --- |
| `micro_code` | Algorithms, math, systems | A runnable case exposes hidden assumptions and edge cases |
| `relational_map` | `holistic`, `contrast` | Forces explicit node/edge labels instead of vague association |
| `encoding_exercise` | `concept`, `contrast` | Blank-page reconstruction builds durable retrieval paths |
| `derivation_trace` | `concept`, `skill` | Verifies step-by-step causal continuity without the book's scaffolding |
| `retrieval_cue` | Definitions, `skill` | Crystallises atomic hooks after comprehension |
| `none` | Any | Conversation-only study when an artifact would be ceremony |

## Error ledger and pivots

Errors use five root causes, never numeric grades: `misconception`,
`discrimination_error`, `prerequisite_gap`, `procedural_slip`, `cue_failure`.
Each entry can be resolved or annotated with a reflection note. A pending
**Pivot Suggestion** proposes a `bridge`, `contrast` or `skill` node with its
diagnosis; only the learner can accept it. Dismissing it changes nothing.

## Project layout

| Path | What |
| --- | --- |
| `src/domain.ts` | Validated schema, node types, artifact catalog, settings |
| `src/framework.ts` | Architect system prompt and child-session brief builder |
| `src/store.ts` | Versioned atomic JSON store under `ctx.dataDirectory` |
| `src/architect-agent.ts` | Persistent Path Architect definition and server tools |
| `src/backend.ts` | RPC handlers, events, native bridge and activation lifecycle |
| `src/view/path-hub.ts` | Path Hub: header, tree, Architect pane, Node Inspector |
| `src/view/*` | Architect chat, inspector, error ledger, pivots, dialogs, tool cards |
| `src/settings.ts` | Artifact defaults, Architect model, safe path deletion |
| `scripts/build.mjs` | Guarded esbuild bundle into `dist/` |
| `scripts/install-plugin-local.mjs` | Portable local installer |
| `scripts/check-sdk.mjs` | Typecheck preflight for the external SDK types |
| `tests/` | Node test runner; public-API host doubles, no model or network |

## Development

```sh
npm test                              # full suite (Node.js 24 runs the TypeScript directly)
node --test tests/lifecycle.test.ts   # one file
npm run typecheck                     # tsc --noEmit, strict mode
npm run build
```

The plugin only imports types from the LearnHarness plugin API, so building
and testing need nothing beyond `npm ci`. Typechecking needs those types, which
are distributed with the LearnHarness plugin SDK rather than in this repository:
copy the SDK's `types` folder to `.sdk/` (it is git-ignored). `npm run
typecheck` explains this if the folder is missing.

| Suite | Covers |
| --- | --- |
| `domain`, `framework` | Schema validation, prompt/brief invariants, no scheduling language |
| `store` | Atomic writes, corrupt/future-version refusal, source dedupe |
| `backend`, `diagnostics`, `session-rpc` | Architect lifecycle, RPC writes, watchpoints, pivots, settings, deletion |
| `native-bridge`, `tool-renderers` | Zero tools for unlinked chats; brief/progress/error/pivot delivery |
| `path-hub*`, `session-*`, `error-ledger`, `pivot-banner`, `settings-page` | View lifecycle, tree, dialogs, session launch/link/navigation |
| `build` | `dist/` layout, manifest, symlink and `dist/data` refusal |
| `lifecycle` | Enable/disable/re-enable idempotency, late async fencing, host-owned Escape, `install:local` preserving `data/` |

All UI tests mount the real views against recorded host primitives and an
in-memory backend. No model request, network call or browser page is involved.

## License

[AGPL-3.0-only](./LICENSE), the same license as the LearnHarness plugin SDK.
