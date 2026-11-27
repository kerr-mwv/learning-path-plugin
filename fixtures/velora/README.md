# Velora knowledge-graph fixture

A deliberately invented, self-contained dataset for testing Knowledge Graph
integration without touching real learner data. The topic is the **Velora bead
system**: two sealed chambers, a `transfer` that moves one existing bead, a
`creation pulse` that adds one new bead, and the combined bead total `T = L + R`.

The fixture is written in the host's on-disk graph format, so it exercises both
the native graph view and the Learning Path graph-informed tutoring branch
(`docs/learner-first-map-revisit`, `src/graph-context.ts`).

## Contents

| Path | Purpose |
| --- | --- |
| `velora-bead-system.md` | The synthetic source note named by graph provenance |
| `graph/nodes.jsonl` | 9 true propositions about the toy system |
| `graph/chains.jsonl` | 5 argument chains (3 single-premise, 2 multi-premise) |
| `graph/sessions.jsonl` | One notes-source extraction checkpoint |
| `graph/sources.json` | `src_velora01` → the fixture note |
| `path/path-velora-beads.json` | A Learning Path whose node titles, goals and anchors overlap the graph propositions |

All graph provenance points at `src_velora01` (an imported-notes source), never
at a chat. The graph therefore renders as one labelled cluster and the tutoring
retrieval is eligible from any linked teaching/practice chat.

## Seed it

The script never guesses a data directory: `--data-dir` is required and must
name a **dev/scratch** LearnHarness data directory, not your real one. It
refuses to seed the OS-default real data directory unless `--allow-real-data`
is passed. It backs up every file it may change.

```sh
# Preview first.
node scripts/seed-graph-fixture.mjs --dry-run --with-path \
  --data-dir /path/to/dev/data

# Seed the graph and the matching Learning Path.
npm run seed:graph -- --data-dir /path/to/dev/data
```

Seeding is append-only and idempotent: existing ledger lines and sources are
preserved, and running it again adds nothing. Backups land in
`<data-dir>/backups/velora-seed-<timestamp>/`.

To remove only the fixture records again (fixture-scoped; no
`--allow-real-data` needed):

```sh
npm run unseed:graph -- --data-dir /path/to/dev/data
```

The remove path refuses to delete a proposition that has gained provenance
outside the fixture unless `--force` is supplied.

## Test the graph-informed tutoring feature

The graph-informed code is not on `experimental`. Build and install the branch:

```sh
git checkout docs/learner-first-map-revisit
npm ci
npm run build
npm run install:local -- "$HOME/.config/LearnHarness/data/plugins"
```

Then in LearnHarness:

1. Start from a fresh window or restart the app so the updated backend loads.
2. Open **Settings → Learning Paths** and turn on **Use graph context for
   teaching and practice**.
3. Open the **Velora bead system: transfers, pulses and reachability** path.
4. Select **Velora's two chambers, transfers and creation pulses** and start a
   **Teaching** chat.
5. In the linked chat, ask a question that calls for prior material, for
   example: *"Before you ask anything, use the recorded graph context to choose
   a question that needs the combined bead total."*

What to look for:

- The native graph view shows 9 propositions and 5 chains, labelled with the
  imported fixture note. The multi-premise chains (`arg_vlra03`, `arg_vlra04`)
  produce implication nodes.
- `learning_path_get_brief` returns a private **Graph context** section for
  linked Teacher/Practice turns. It is agent-only: the learner-visible opening
  prompt from `sessions.prepare` stays graph-free.
- `learning_path_search_graph` is registered for linked Teacher/Practice turns
  and can be queried directly with terms such as `combined bead total`,
  `creation pulse` or `transfer`.
- The Prober and unlinked chats receive no graph context and no search tool.
- With the setting off, both the graph section and the search tool disappear.

Useful units and their expected matches:

| Path unit | Likely graph matches |
| --- | --- |
| Velora's two chambers, transfers and creation pulses | Velora state, transfer, creation pulse, total invariance |
| Transfers preserve the combined bead total | transfer, total invariance, no removal |
| Creation pulses raise the combined bead total by one | creation pulse, pulse raises total |
| Transfer versus creation pulse: same left count, different total | same left count, transfer, creation pulse |
| Detecting a creation pulse from the combined total | total rise implies pulse, pulse raises total, total invariance |
| Reachability checkpoint: transfers alone | transfer reachability, total invariance |
| Implement a Velora reachability checker | transfer reachability, no removal |

Retrieval is lexical, bounded to five results and capped per field. A missing
match is not a failure; it means the query wording did not overlap a statement
or recorded alias.

## Safety notes

- The fixture is fictional. Do not present it as real course material.
- The seed script never writes chats, sessions, transcripts or model output.
- If the app is open while seeding, restart it (or wait for the graph revision
  to refresh) before inspecting the graph.
- Back up `data/` yourself before any irreversible cleanup. `--remove` is
  fixture-scoped, but it still rewrites ledgers.
