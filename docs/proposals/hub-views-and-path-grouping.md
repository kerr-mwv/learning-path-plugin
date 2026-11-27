# Path Hub views and path grouping (research + brainstorm)

Status: implemented on `exp/path-hub-views` (domain tags +
`paths.updateMeta`, the Paths overview dashboard, the module-lane roadmap,
and the recorded-structure graph). The open decisions below are resolved as
marked. The README workflow/test-table updates are pending, separate from
in-flight README edits on the branch.

## The question

Today the Path Hub is a single surface: a path `<select>` in the header, one
module → node → child-chat tree, the Architect pane and the Node Inspector.
Two pressures motivate revisiting it:

1. **Orientation within one path.** A deep tree answers "what is inside module
   3?" but not "what is the shape of this path?" Modules, proactive
   `holistic`/`contrast` structure and accepted bridges are the framework's
   load-bearing ideas, and none of them is *visible* as structure in an outline.
2. **Orientation across paths.** A `<select>` dropdown does not scale past a
   handful of paths, and there is no way to organize paths by exam, field or
   project — the learner's real reason for having several.

## Hard constraints from the essence

Any view must not smuggle back what the framework deliberately rejects
(`FRAMEWORK.md`, README workflow section):

| Principle | What it forbids in a UI |
| --- | --- |
| Ungated progression, zero scheduling | No dates, hours, streaks, "days left", daily goals, or a "you are behind" cue of any kind |
| Advisory-only adaptation | No auto-rearranged layout; nothing moves, regroups or disappears without a learner action |
| No invented curricula | The view renders only what the record asserts (modules, node types, anchors, watchpoints, pivots) — never drawn edges that look like prerequisites the Architect never wrote |
| Generative artifacts with stated reasons | If a view recommends an artifact, it shows the "why" inline, as the inspector does today |
| Misconceptions by root cause | Error surfacing stays qualitative ("3 unresolved: discrimination errors"), never a numeric grade or red "failing" state |
| Source grounding | The source spine (canonical vs uploaded) stays visible at the overview level, since it is the path's claim to legitimacy |

One existing tension to resolve honestly: the header already shows
"X of Y nodes consolidated." That reads as inventory, not pressure — an
honest count. Any dashboard should keep that register (counts, distributions)
and avoid percentage rings, progress bars that imply completion targets, or
"80% done!" framing.

## Survey: how do curricula get presented elsewhere

A synthesis of familiar products and general HCI guidance (Shneiderman's
*overview first, zoom and filter, then details-on-demand* is the touchstone).
Each is scored against the essence above.

### Linear skill-path strips (Duolingo, Brilliant, Codecademy)

One station after another, you cannot open station 5 before station 4. Best-in-
class for momentum and reducing choice; built around streaks and daily goals.
**Fit: poor.** Gating, scheduling pressure and implied order are precisely
what principle 7 rejects, and interleaving (principle 5) breaks linearity by
design. Worth borrowing only one thing: the calm of *large, few, obvious
targets to tap*.

### Roadmaps (roadmap.sh-style topical maps)

Columns/lanes of a field, "deep" vs "shallow" markers, no time axis. Excellent
for "where am I in this whole field" orientation. **Fit: mixed, depends on
what the lanes mean.** If we render *modules as lanes* and nodes as cards, we
draw only recorded structure — honest. If we let an auto-layout draw *edges*
between nodes to suggest prerequisites, we invent a curriculum visually. The
honest version is: **module swimlanes, node cards, no connecting arrows.**
Bridges/contrasts/holistic cards get distinct color/badges so the proactive
structure is finally *visible*.

### Outlines/trees (current UI, docs apps, file browsers)

Proven for ≤3 levels of hierarchy, cheap on host primitives (`ctx.ui.mountTree`),
accessible, and already wired for selection → inspector. Weakness is exactly
the two pressures above: no gestalt, and path switching is a dropdown.
**Fit: good, keep as the detail/list mode.**

### Kanban by progression (GitHub Projects / Trello style)

Columns `unstarted → in_progress → consolidated`. **Fit: reject.** It converts
epistemic states into a workflow to be pushed rightward — completion pressure
by layout — and it strips nodes of their module context, which is where
anchors and interleaving live.

### Dashboards over many goals (Exercism track picker, GitHub Projects
### with grouping)

A home surface of cards, each card summarizing one effort, with grouping and
filtering by learner-defined metadata. **Fit: good, with the register kept
honest** (counts and distributions, not percentages/rings). This is the natural
answer to "a list of paths, grouped by exam or field."

### Graph/topology renderings

Radial or force-directed node graphs. The irony: the framework *loves*
relational maps — drawn by the learner as artifacts.

The original objection here was sharper than "graphs are bad": an auto-generated
graph would do the learner's generative work *and* invent edges the Architect
never wrote. Both remain rejected. What is honest is narrower: a **deterministic
graph of the recorded structure only** — modules as clusters, nodes as cards,
and an edge exactly where `interleavesNodeIds` records one, laid out in module
columns rather than by a force simulation. The Architect wrote those links; the
view merely draws them. Relational maps stay learner artifacts (surfaced via
`artifactNote` in the inspector), not a substitute for this view.

## Brainstorm: the two-surface proposal

### Surface 1 — Paths overview (dashboard, replaces the `<select>` as the hub landing)

- Grid of path cards, each showing: title, goal (truncated), source spine mode
  with the source titles, module/node counts, node-state *distribution strip*
  (segmented bar: consolidated / in progress / unstarted, labeled with counts),
  pending pivots and unresolved watchpoint counts as badges.
- **Custom fields as tags.** A bounded free-form `tags: string[]` on the path
  record (learner-managed, e.g. `exam:step-2`, `field:distributed-systems`,
  `project:rag-eval`). Grouping is a client-side filter over tags; no tag
  schema, no fixed "type" column — the learner decides what their dimensions
  mean, which honors the plugin's refusal to model scheduling or external
  goals. Validation mirrors `title` handling: max ~8 tags, ~40 chars each,
  normalized on save; unknown keys already ignored on read, so old paths
  simply have no tags.
- Tag editing lives beside the path (a small menu on the card or in the
  inspector), never in the Architect conversation: tags are learner metadata,
  and keeping them out of the Architect's tool surface means no drift between
  what the agent designed and how the learner files it.

### Surface 2 — In-path view toggle: graph ↔ module-lane roadmap

- The default (and only outline) view is a recorded-structure graph: each
  module is a cluster, each node a selectable card, and the only lines drawn
  are the recorded `interleavesNodeIds` links. The host tree widget
  (`ctx.ui.mountTree`) is gone from the Path Hub.
- The alternate lens is the roadmap: each module is a horizontal lane; node
  cards show type badge, progression badge, anchor, unresolved-error badge; no
  arrows, no dates, no "up next" recommender. Checkpoints visually mark module
  ends; accepted bridge nodes stand out as the repair history they are.
- Selection behavior is identical in both modes (tap card → inspector), so the
  inspector, Architect pane and session-launch flow are untouched.
- A toggle is honest to "advisory-only": the learner chooses the view; nothing
  about the path record changes.

### Explicitly out of scope (for now)

- Any "recommended next node" widget — even advisory, it reads as a schedule.
- Percentage rings, streak-adjacent anything, due-anything.
- Auto-drawn prerequisite edges, force-directed or otherwise auto-arranged
  layouts. The graph draws only recorded `interleavesNodeIds` edges in a
  deterministic module-column layout; it never infers a prerequisite.
- Reordering nodes by drag-and-drop: the Architect is the only thing that
  restructures a path, via drafts and accepted pivots.

## Grounding in the code

Where each piece would land, so the effort is estimable:

- **Tags (data):** `LearningPath` gains optional `tags`; validation in
  `src/domain.ts` beside `readString(record.title, ...)`; `paths.list`
  summary (`src/backend.ts` `summarize`) gains `tags` so the dashboard never
  loads full records; one new RPC `paths.updateMeta` (tags only, mirroring
  `paths.updateNode`'s guard-and-rebuild pattern); export JSON/Markdown gain a
  tags line (`src/export.ts`); store version stays 1 since absence is valid.
- **Dashboard (view):** a new `src/view/paths-overview.ts` mounted above /
  instead of the header select in `src/view/path-hub.ts`; reuses
  `ctx.ui.mountBadge`, buttons and menus only; tests follow the existing
  `path-hub*` pattern (linkedom mount + in-memory backend).
- **Graph and roadmap modes (view):** deterministic renderers over the same
  `LearningPath` payload the tree used to consume; DOM-built cards inside the
  existing path pane host, one toggle button in the header. The graph adds a
  decorative, `aria-hidden` SVG edge layer positioned from card boxes; the
  inspector's "Interleaved prior nodes" list remains the accessible record.

## Decisions, as implemented

1. **Both surfaces landed**, tags + overview first, then the roadmap. The
   header select stays beside the cards: it is the compact quick-switch, the
   overview is the dashboard; both drive one selection path.
2. Tags live only at the overview (Edit tags per card) — Settings already
   carries enough, and bulk edits invite treating tags as structure rather
   than filing.
3. The distribution strip always ships a labeled count line
   (`PROGRESSION_LABELS` text plus an `aria-label` on the strip), so color
   never stands alone.
4. A 1-module path hides the toggle entirely (mounted but hidden, so the
   widget state stays consistent); a held `roadmap` mode falls back to the
   graph if a path drops below two modules.
5. One extra rule surfaced during implementation: a held tag filter survives a
   path losing its last instance of that tag — the option stays listed, and
   the grid says "No paths carry this tag" instead of silently dropping the
   filter.
6. Overridden after live review: the overview now **pages five path cards at a
   time** with an honest pager (`Page x of y`, Previous/Next). The earlier
   no-pagination rule was written before the dashboard existed; paging is
   presentation, never hiding — the count line still reports the whole
   filtered set, and no path is unreachable. Also from live review: the
   detailed view floats (it used to squeeze the graph pane to half a
   column), and closing it is an explicit learner choice that background
   refreshes respect.
6. The Path Hub's outline is now a graph, not a tree. The earlier "reject
   auto-graph" stance rejected *invented* edges and auto-arranged layouts; it
   did not reject drawing the structure the Architect recorded. The graph
   therefore plots only `interleavesNodeIds` links, in module columns, with
   the edges hidden from assistive tech — the inspector's interleaved-prior
   list is the accessible equivalent.
