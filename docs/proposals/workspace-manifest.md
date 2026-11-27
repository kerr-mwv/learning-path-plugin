# Path workspaces: the manifest and the ledger (brainstorm → plan)

Status: experimental, with phased implementation. Phases 1–4 delivered the basic
store, notes end-to-end, session artifacts, and generalized uploads. Phase 5 is
delivered on `feat/workspaces`: bidirectional resync-on-read
(`workspace.resync`), human-readable slugged filenames with YAML frontmatter,
link-scoped agent reads, native DOM buttons in the workspace pane, the
`mountTree` ledger with in-place previews (retiring the separate viewer), and
the ledger as a tab of the floating details window — one window, the same
treatment as the node details (retiring the separate floating overlay, the
third grid column and the fullscreen toggle).

## The question

Learning happens outside the harness. The learner keeps notes in a text editor
open beside LearnHarness, writes code in their own environment, reads PDFs in
their own viewer — and none of it can enter a path. The seams are visible in
the record today:

- `artifactNote` is a single optional string on a node. Principle 6's whole
  point is generative artifacts, yet the artifact itself lives nowhere.
- Uploaded sources can only enter a path as a spine or a supplement chosen at
  design time. There is no way to say "this paper is perfect for *this* node"
  mid-path.
- The Error Ledger's `notes` field is a single-string escape valve for
  reflection that wants to be a document.
- Map revisit asks the learner to redraw earlier relational maps from memory
  of scrollback, because nothing was ever saved.

## Decisions (resolved in review)

1. **One Workspace per path** (1:1). Cross-path discovery stays the Paths
   overview's job — its search already covers title, goal and learner tags,
   so nothing is lost by not making the workspace a multi-path container.
2. **The manifest is a current-state index, not an event log.** A snapshot
   with `updatedAt` and per-item provenance (`addedBy`, `addedAt`), validated
   and written with the store's existing discipline. No log-replay machinery.
3. **Brief injection is titles-only.** The child session brief lists linked
   items by kind and title; content stays behind a bounded read tool, so the
   brief remains small no matter how much material accumulates.
4. **Deleting a path deletes its workspace.** It is one learner decision; the
   guard is that removal only happens through the existing explicit
   `paths.delete` flow. Nothing else ever removes a workspace.
5. **Naming: "Workspace."** Workspace items, `workspace.*` RPCs, a Workspace
   section in the Node Inspector. The manifest is the ledger; files are the
   truth. ("Space" was rejected to avoid collision with the user's other
   tooling; "Workspace" reads as a place you work, not a curriculum.)
6. **Link relations for v1: `grounds`, `informs`, `produced_by`.** `evidence_of`
   ("this item is proof understanding held" — a solved problem set, a green
   test run) is deferred: anything it would capture enters today as a note or
   code item linked `informs`. It is one enum value to add when a need shows.
7. **Order: notes first.** The external-editor use case is the primary one;
   session-artifact saving (smaller diff) lands second.
8. **Files on disk are the source of truth, not the manifest.** The manifest
   is an index kept in sync with the file system via YAML frontmatter in each
   note file. A learner editing a `.md` file in their own editor is a first-class
   use case — the plugin detects the change, re-reads frontmatter, and updates
   the manifest. Manifest corruption recovers by re-hydrating from files.

## What a workspace is

Additive to the path record — the path schema is untouched, and a workspace
materializes lazily on first item, so existing data needs no migration.

```text
paths/<pathId>.json                            unchanged curriculum record
workspaces/<pathId>/manifest.json              versioned, validated, atomic
workspaces/<pathId>/files/<slug>-<uuid>.md    item content, human-readable slug from title
```

### Self-describing Markdown files

Every note, session artifact, and code file is a plain Markdown file with a
YAML frontmatter header:

```markdown
---
id: "a1b2c3d4-e5f6-..."
kind: note
title: "Open questions after DSA Lecture 7 — Graph algorithms"
addedAt: "2025-01-15T14:32:01.000Z"
links:
  - to: n-graph-algorithms
    rel: informs
---

Why does DFS not guarantee the shortest path in an unweighted graph?
Could the lecturer's proof be extended to directed acyclic graphs?
```

- **id**: stable UUID, still present in the filename suffix for collision handling.
- **kind**, **title**, **links**: re-hydrated on every load so the manifest can
  be rebuilt from the filesystem.
- **All other metadata** (byteSize, sha256, caption, addedBy) stays in the manifest.

### Manifest = index, files = truth

Every store write updates both the file and the manifest; the manifest is
never the truth. External edits are picked up by **resync-on-read**: the hub's
workspace refresh calls `workspace.resync`, which scans `files/`, parses each
frontmatter, and lets the files win over the index.

When a file is edited externally (title, links, body):
1. The next `workspace.resync` re-reads the file and parses its frontmatter.
2. The manifest entry is updated — external edits win; the store never
   renames a file the learner just saved from their editor.
3. A changed workspace is rewritten atomically and `EVENT_WORKSPACE_CHANGED`
   is emitted so any open window refetches. An unchanged workspace is never
   rewritten.

A file the learner creates outside the harness (valid frontmatter, bounded
content, links that resolve) materializes as a new learner item on the same
resync. Files without parseable frontmatter, oversize files, and symlinks are
skipped, never guessed at. A missing file never deletes its manifest entry —
deletion is a learner decision, as everywhere.

A filesystem watcher (`fs.watch`) remains a possible refinement so edits land
without waiting for the next refresh; resync-on-read is the honest baseline:
the ledger reflects the learner's editor the moment anyone looks at it.

Learner edits in the external editor win over stale in-memory state.

### Human-readable filenames

Item content files use a slug derived from the title, not a bare UUID:

```text
open-questions-after-dsa-lecture-7-graph-algorithms-a1b2.md
```

- Slug is kebab-case, alphanumeric, lowercased, capped at 60 characters.
- The full item UUID stays as the filename suffix, so two notes sharing a
  title never collide and external references remain valid.
- On a title rename through the plugin, the file moves to its new slug and
  its frontmatter is rewritten; a title edited *externally* updates the
  manifest but never renames the file out from under the learner's editor.

Cross-platform safety: Windows-forbidden characters `< > : " / \ | ? *` are stripped.

### Bidirectional sync

The working model is **write anywhere, read everywhere**:

- Learner writes a note in VS Code while LearnHarness is open — the next hub
  refresh resyncs, and the updated title, links and body appear in the ledger
  and in agent reads (frontmatter is stripped, the body reads verbatim).
- Learner drops a PDF onto the pane — it converts and writes the file; external
  editors see it immediately.
- Agent reads workspace items **only when they are linked to the session's
  node**. The brief lists linked items by title only;
  `learning_path_read_workspace_item` refuses anything else — unlinked notes
  and notes filed under other nodes stay learner-private.

### Learner-owned, agent-advised

Agents write only their own `session_artifact` items. They never create, edit,
link or delete learner items. Link suggestions reuse the pivots' advisory
accept/dismiss pattern.

### Context is link-scoped

A workspace item only becomes agent-readable context when the learner links it
to a node. The brief tool injects linked items; the per-turn read tool only
offers linked items. Unlinked items are learner-private browsing material — they
show up in the ledger, they export with the path, but they never leak into an
agent context.

This mirrors the "write anywhere" workflow: a learner creating a quick scratch
note during a lecture does not pollute any agent session. When they later file
it under a node, it enters context.

Item shape (validated in `src/domain.ts` beside the existing validators):

```ts
WORKSPACE_ITEM_KINDS = ["note", "session_artifact", "source", "code"]
WORKSPACE_LINK_RELS   = ["grounds", "informs", "produced_by"]

interface WorkspaceItemLink { to: string /* nodeId | "space" */, rel: WorkspaceLinkRel }
interface WorkspaceItem {
  id, kind, title,
  sourceId?,           // kind "source": reference into the global sources store
  byteSize?, sha256?,
  addedAt,
  addedBy: "learner" | "architect:<chatId>" | "session:<chatId>",
  caption?,
  links: WorkspaceItemLink[]
}
interface WorkspaceManifest { schemaVersion, pathId, updatedAt, items: WorkspaceItem[] }
```

Caps mirror existing conventions: title ≤ 200 chars, note content ≤ 256 KiB,
≤ 300 items per workspace, links validated against real node ids. A link to a
deleted node drops at read with the item kept — never data loss.

## Guardrails (framework discipline applied to stuff)

- No unread counts, no "new" badges, no inbox anxiety. The ledger is
  navigational, not judgmental. Counts are honest inventory, as elsewhere.
- No scheduling semantics may attach to an item: no dates beyond `addedAt`,
  no review queues, no "you haven't added anything in a while".
- Ungated: any item may link to any node regardless of progression state.
- Notes round-trip Markdown verbatim — the learner's editor is the source of
  truth for their own writing; the workspace never reformats it.
- **Link-only context**: unlinked items never appear in agent briefs.

## Phases

Each is one reviewable change, on its own space branch off `experimental`.

1. **Store** (`workspace 1/4`). Domain kinds/rels/validators/caps; store
   functions for manifest and content files; `paths.delete` extended to
   remove the workspace directory. No RPCs, no UI.
2. **Notes end-to-end** (`workspace 2/4`). `workspace.*` RPCs; a Workspace
   section in the Node Inspector (add note, link/unlink, delete); the brief's
   titles-only "Learner workspace material" section plus the bounded
   `learning_path_read_workspace_item` per-turn tool; Markdown export gains a
   Workspace section with note content verbatim. README and FRAMEWORK gain
   their Workspace entries here, with the first user-visible surface.
3. **Session artifacts** (`workspace 3/4`). `learning_path_save_artifact`
   per-turn tool: a session that produced its recommended artifact saves the
   full text as an item, auto-linked `produced_by` → node, `addedBy` the
   session chat. `artifactNote` stays as the agent's short summary. Map
   revisit then cites the learner's *saved* relational maps.
4. **Generalized uploads** (`workspace 4/4`). The Architect Pane upload flow
   can file a converted document as a node-linked workspace item (`grounds`)
   instead of only as spine corpus; Architect refinement context lists
   node-linked items by title.
5. **Bidirectional sync + human-readable files + frontmatter** (`workspace 5/4`).
   Delivered on `feat/workspaces`:
   - Replaces the UUID-only filename scheme with human-readable slugs (the
     full UUID stays as the suffix; legacy `<itemId>.md` names still read).
   - Adds YAML frontmatter (id, kind, title, addedAt, links) to every
     content-bearing file on disk, escaping quotes, backslashes and newlines
     so titles round-trip.
   - Introduces bidirectional sync as **resync-on-read**: a new
     `workspace.resync` RPC (used by the hub on every refresh) re-hydrates the
     manifest from the files — external edits win, and externally created
     files materialize as learner items. Symlinks are never followed; oversize
     or unparseable files never sync; nothing is ever deleted by a sync.
     `fs.watch` remains a future refinement, not part of this phase.
   - Switches the workspace pane's in-body buttons to native DOM elements
     (fixing the fullscreen hit-target breakage); `mountButton` remains only
     on the pane bar and in dialogs, which the host positions itself.
   - Hardens the link-scoping rule: `learning_path_read_workspace_item`
     serves only items linked to the session's own node (matching the brief,
     which already listed linked items only). Unlinked and cross-node
     material is learner-private; `space` links do not count as node links.

   The two items once deferred here are now delivered with the rest of phase
   5: the ledger list is the host tree (`ctx.ui.mountTree()`, with keyboard
   navigation, columnar rows and in-place previews that retired the separate
   viewer), and the ledger is a tab of the floating details window, so the
   floating overlay, the third grid column and the fullscreen toggle are all
   gone — notes get exactly the windowing the node details get.

## Out of scope (v1 and v5)

- **Images**: a `kind: "image"` ledger entry with a learner caption, content
  stored but not agent-readable — no OCR, the same honesty as
  `ctx.documents.toMarkdown` refusing image-only PDFs.
- **Advisory link suggestions**: sessions propose links the learner accepts or
  dismisses; agents never write learner-item links.
- Any auto-tagging, auto-summarizing or auto-arranging of learner material.
- Direct text-file editing inside the plugin (the external editor is the
  first-class surface; the plugin provides linking, indexing, and context
  injection).

## Live-review overrides after phase 2

From hands-on testing of the notes surface, recorded in the same spirit as the
hub-views proposal's overrides:

1. **The ledger left the Node Inspector's inline section — and came back as
   the window's second tab.** The inline section read as cramped ("grounded")
   and made the inspector heavy, so it first became a separate pop-out pane
   (a floating half-pane with its own fullscreen toggle) and then, after the
   fullscreen toggle proved brittle and the pane stacked underneath the
   details in narrow layouts, a tab of the floating details window: the same
   pinned, drag-resizable, expandable window the details live in, one click
   away, never a second floating surface. Note content loads on demand, only
   when a row expands: the tree lists titles, `workspace.readItem` fetches the
   body.
2. **Filing loosened from the inspected node.** Adding a note per node is
   onerous; a note may now be created unlinked and linked to several nodes at
   once (a node picker in the pane, rel `informs`, through the existing
   `workspace.updateItemMeta` links array). The per-node flow remains but is
   no longer the only path.
3. **Opening the OS directory that holds workspace files is deferred.** The
   host exposes no reveal-a-folder primitive, and the plugin does not spawn
   processes off-contract. Drag-and-drop of files onto the pane is the
   plugin-side equivalent and lands with the uploads phase.

## Phase 5 UI changes

### Native DOM buttons

The workspace pane previously used `ctx.ui.mountButton` for every button.
When the pane toggled into fullscreen (`position: fixed inset: 12px`), host-mounted
widgets often did not recalculate hit targets, breaking interactivity.

Fix: the ledger's navigation and action buttons (Open folder, Add Note,
Links…, Delete, the filing strip's picker) are now plain `<button>` elements
styled with plugin CSS (`.lp-btn`), which reflow for free. The floating
window's own bar buttons (Expand, Close) stay on `mountButton` because the
host owns the bar's positioning; the tab buttons in that bar are native DOM
for the same fragility reason; dialogs keep their mounted Save buttons, and
`mountMarkdown` remains the preview's renderer.

### mountTree for the ledger list

The custom `<ul>` / `<li>` row list is replaced with `ctx.ui.mountTree()`: the
host owns rows, columns, keyboard navigation and virtualization, and the pane
supplies controlled rows — title in the lead column, kind (icon), filing and
actions as columns. Each row carries a disclosure that expands the item's
Markdown preview in place; the body is still fetched lazily through
`workspace.readItem`, only at the moment of expansion, and the fetched preview
is cached across refreshes. The separate viewer pane (and with it the
fullscreen toggle that existed only to lift the viewer's scroll cap) is
retired: the note never leaves the list. Row updates go through the tree
handle (`update({ rows })`), so one disclosure toggle never remounts the other
expanded previews.

### The ledger as a tab of the floating details window

The workspace ledger and the node details are two views of one floating
window: the window's bar carries a tab row (Node details | Workspace ledger,
the tab's label carrying the honest item count), Expand fills the whole
viewport below the header — the bottom edge is pinned and the top edge keeps
the same measured pin the floating window uses, so the ledger tree grows to
the full height and the window's bar never tucks under the header — the grip resizes, Close dismisses, and the window's scroller
serves whichever tab is in view. Dragging the bar moves the whole window
(vertically and horizontally) off its pinned spot — clamped so it never
leaves the viewport, surviving refreshes, and reset by a double-click — and
the bar's Expand/Restore/Close controls are icon-only host buttons (the label
stays the accessible name, the hover title carries the word). The ledger
header's own affordances follow suit — a + for Add Note, an open folder for
Open folder — and the kind icons and the filing strip's glyph read in the
harness's own white rather than muted chrome, with the strip's picker sitting
at its right end. A content-bearing item can also leave the list entirely:
Open in editor hands the item's file to the OS, which opens the learner's
chosen application (prompting for one wherever no default is registered) —
the frontmatter keeps an external edit resyncable, and a source, which
references the global library, offers no such affordance. A split-pane third grid column was tried
first — it fixed the fullscreen hit-target breakage but stacked the ledger
beneath the details in narrow layouts — so the ledger joined the window the
details already own: one set of windowing affordances, no second floating
surface, no z-index, and the window's Expand is the big reading surface the
old fullscreen toggle tried to be. The tab choice survives refreshes and node
switches (the ledger is for the path, not one node); a closed window or a new
path resets to the details tab. Open folder lives in the ledger header, beside
Add Note.
