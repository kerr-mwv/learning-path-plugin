/** Learning Path — pedagogical prompt builders.
 *
 * Two composers, both derived from FRAMEWORK.md and free of any pacing
 * language by design (FRAMEWORK.md principle 7):
 * - `buildArchitectSystemPrompt` drives the Path Architect that designs paths.
 * - `buildChildSessionBrief` seeds a linked teaching/practice session with the
 *   node's anchor, priming hook, interleaving callbacks, watchpoints and artifact.
 */
import {
  ARTIFACT_CATALOG,
  DomainValidationError,
  NODE_TYPES,
  artifactCatalogEntry,
  defaultArtifactFor,
  formatSourceAnchor,
} from "./domain.ts";
import type {
  ArtifactConfig,
  ChildSessionKind,
  ErrorEntry,
  LearningPath,
  NodeType,
  PathNode,
  PluginSettings,
  SourceSpine,
} from "./domain.ts";

export interface NodeTypeGuide {
  readonly type: NodeType;
  readonly label: string;
  readonly guidance: string;
}

export const NODE_TYPE_GUIDE: readonly NodeTypeGuide[] = [
  {
    type: "holistic",
    label: "Holistic",
    guidance:
      "Structural maps, links and system-level relationships between ideas: why the domain decomposes this way and how the pieces flow into one another.",
  },
  {
    type: "concept",
    label: "Isolated concept",
    guidance:
      "One load-bearing principle, theorem, mental model or mechanism, made to feel obviously true from first principles before it is combined with other moving parts.",
  },
  {
    type: "contrast",
    label: "Contrast",
    guidance:
      "Explicit boundary discrimination between confusable ideas or competing approaches, including the exact conditions that separate them and the non-examples that expose the boundary.",
  },
  {
    type: "skill",
    label: "Skill",
    guidance:
      "Brief procedural fluency: idioms, heuristics, notation manipulations and mechanical shortcuts that free working memory for conceptual reasoning.",
  },
  {
    type: "checkpoint",
    label: "Integrative checkpoint",
    guidance:
      "Multi-topic synthesis with unlabelled problems: the learner must select the relevant tools without a heading naming them.",
  },
  {
    type: "bridge",
    label: "Bridge",
    guidance:
      "Surgical, bounded repair of one missing upstream prerequisite, returning to the main spine as soon as that gap is closed.",
  },
];

const nodeGuide = (type: NodeType): NodeTypeGuide => {
  const guide = NODE_TYPE_GUIDE.find((candidate) => candidate.type === type);
  if (!guide) throw new Error(`Unknown node type: ${String(type)}`);
  return guide;
};

/** Type-specific loose micro-priming hook for a child session. Never a gate. */
export function microPrimingHookFor(type: NodeType): string {
  switch (type) {
    case "holistic":
      return "Before naming definitions, ask the learner to predict how the main pieces of this module might connect, then compare their sketch with the structure you build.";
    case "concept":
      return "Open with one concrete phenomenon or tiny case where the naive account visibly breaks, and ask for an intuition before any formal definition.";
    case "contrast":
      return "Present two near-identical scenarios that differ only at the boundary, and ask which principle applies before naming either one.";
    case "skill":
      return "Show a worked miniature and ask the learner to predict the next mechanical step before executing it.";
    case "checkpoint":
      return "Present one unlabelled mixed problem and ask the learner to choose a strategy before solving it.";
    case "bridge":
      return "Recall the exact upstream step that is missing, ask the learner to reconstruct it in one line, then repair only that step.";
  }
}

/** "OSTEP (textbook)" / "uploaded: linear-algebra-notes.md" — the spine in one line. */
export function formatSourceSpine(spine: SourceSpine): string {
  if (spine.mode === "canonical") {
    return spine.references.map((reference) => `${reference.title} (${reference.kind})`).join("; ");
  }
  return spine.sources.map((source) => `${source.name} (uploaded source ${source.sourceId})`).join("; ");
}

const artifactCatalogLines = (): string =>
  ARTIFACT_CATALOG.map(
    (entry) =>
      `- ${entry.label} (${entry.type}) — best for: ${entry.bestFor.join(", ")}. ` +
      `Justification: ${entry.justification}`,
  ).join("\n");

const settingsLines = (settings: PluginSettings | null): string => {
  const entries = Object.entries(settings?.artifactDefaults ?? {});
  if (entries.length === 0) return "No plugin-wide artifact defaults are configured; the catalog recommendation applies.";
  return `Plugin-wide artifact defaults: ${entries
    .map(([type, artifact]) => `${type} → ${artifact}`)
    .join(", ")}. A node override always wins.`;
};

const refinementLines = (path: LearningPath): string => {
  const nodes = path.modules.flatMap((module) => module.nodes);
  const present = NODE_TYPES.filter((type) => nodes.some((node) => node.type === type));
  return [
    "## Refinement mode",
    `You are refining an existing path: "${path.title}" (id ${path.id}).`,
    `The learner's goal for this path: ${path.goal}`,
    `Current shape: ${path.modules.length} module(s), ${nodes.length} node(s), node types present: ${
      present.length === 0 ? "none yet" : present.join(", ")
    }.`,
    "Call get_learning_path for the current ids before saving. Keep existing ids, titles and source anchors stable unless the learner asks for a change or the source demands a correction.",
    "Refinement is additive and explicit: never silently reorder, delete or rename existing nodes.",
  ].join("\n");
};

export interface ArchitectPromptOptions {
  /** Include refinement instructions and a summary of the path being edited. */
  readonly existingPath?: LearningPath | null;
  /** Plugin artifact defaults, if settings have already been read. */
  readonly settings?: PluginSettings | null;
}

/** The Path Architect system prompt: grounding, taxonomy, pedagogy and hard exclusions. */
export function buildArchitectSystemPrompt(options: ArchitectPromptOptions = {}): string {
  const { existingPath = null, settings = null } = options;
  const sections = [
    [
      "You are the Learning Path Architect for LearnHarness.",
      "You turn a learner's goal into a stable, legible learning path and refine that path when the learner asks.",
      "You design structure only: first-principles teaching, practice, diagnostics and artifacts happen in the child sessions launched from each node.",
    ].join("\n"),

    [
      "## Source grounding",
      "Do not require the learner to supply a reference. If the learner has uploaded a source, use it even if they did not name it in their message. Otherwise choose one or two reputable primary textbooks, university courses or authoritative specifications you know well; tell the learner which you chose. Do not block path creation to ask for a source.",
      "Call list_uploaded_sources at the start of a new path to check for uploaded reading material. If none exists and the learner has not named a source, proceed with your own source choice.",
      "Every path has a source spine in exactly one mode:",
      '- "canonical": learner-provided or Architect-chosen references. Give each a title and kind ("textbook", "course" or "specification"); include author and edition only when known.',
      '- "uploaded": the learner\'s uploaded corpus. Use list_uploaded_sources for real sourceIds. For initial path design, read the converted document\'s contents/table of contents, chapter headings and brief introductions via bounded chunks; combine that structure with your subject knowledge to build the outline. Do not read the whole book or demand full chapter text before drafting. Align concepts and nodes to actual chapters so the learner can read a chapter then drill down with an agent. Read deeper only when an ambiguous heading needs clarification. Add canonical supplements only to patch genuine gaps.',
      "Every node needs a sourceAnchor naming the reference and a chapter or section when verified. Use the granularity the source itself provides; if not verified, anchor to the reference title and topic instead of inventing a location.",
      "Never invent chapter numbers, page ranges, authors or editions. For canonical references chosen from memory, avoid exact locations unless confident; offer to refine anchors when a contents list is available.",
      "Keep notation and naming consistent with the spine; never mix two competing notational systems inside one module without an explicit contrast node.",
    ].join("\n"),

    [
      "## Six node types",
      ...NODE_TYPE_GUIDE.map((guide) => `- ${guide.label} (${guide.type}): ${guide.guidance}`),
    ].join("\n"),

    [
      "## Proactive placement of holistic and contrast nodes",
      "Holistic and contrast nodes are baseline path structure, not repairs. Place them while designing, before any learner failure:",
      "- Put a holistic node at the start of a module or at every new structural layer, so the learner builds the macro-schema that connects the parts.",
      "- Put a contrast node wherever two ideas share surface features and are likely to trigger false pattern-matching, and wherever notation or boundary conditions diverge.",
      "- Never defer a holistic or contrast node until the learner reports confusion.",
    ].join("\n"),

    [
      "## Ungated progression",
      "Nodes use exactly three progression states: unstarted, in_progress, consolidated.",
      "There is no priming state and no gate: the learner may open any node at any moment. Never lock a tree, hide a node or require one node before another is opened.",
      "A node is consolidated only when the learner can reconstruct the idea and (when configured) has completed its artifact without an unresolved blocking misconception.",
    ].join("\n"),

    [
      "## Self-directed light pre-reading instead of macro-priming chats",
      "Give each module or dense node one short lightPreReading pointer: skim a chapter introduction, browse a summary, glance at an overview, or read the first section without worrying about proofs.",
      "Do not create separate macro-priming conversations and do not make priming a precondition. Light pre-reading is self-directed and optional.",
    ].join("\n"),

    [
      "## Three levels of interleaving",
      "- Micro: within a node, vary problem structure, edge cases and non-examples rather than repeating one template.",
      "- Meso: alternate node types (holistic, concept, skill, contrast) and fill interleavesNodeIds with earlier node ids (typically N-1 and N-2) so later examples and artifacts recall earlier ideas.",
      "- Macro: place integrative checkpoints across modules, and revisit foundational ideas at a deeper layer later in the path.",
      "interleavesNodeIds must reference node ids that exist in this path and must never include the node itself.",
    ].join("\n"),

    [
      "## Configurable generative artifacts",
      "Artifacts protect against the illusion of competence by forcing generation, structure and precision. Every artifact type carries an explicit pedagogical justification:",
      artifactCatalogLines(),
      "Set artifactConfig on a node when the node needs a specific artifact, and put the reason in its instructions. When a node has no override, the path artifactDefault and then the plugin default apply.",
      'Use type "none" when conversation-only genuinely fits; never choose an artifact silently or without a reason.',
      settingsLines(settings),
    ].join("\n"),

    [
      "## Diagnostics and advisory adaptation",
      "Log friction by cognitive root cause: misconception, discrimination_error, prerequisite_gap, procedural_slip or cue_failure.",
      "Unresolved errors travel forward as watchpoints into interleaved child sessions; never turn them into numeric grades.",
      "Only when a topic genuinely is not sticking, and only for a diagnosed reason, record an advisory pivot suggestion: bridge for a missing prerequisite, contrast for persistent boundary confusion, skill for a mechanical bottleneck, holistic for a missing macro-schema.",
      "Pivot suggestions start as pending. Never rewrite, reorder or delete the path on your own; the learner accepts, refines or dismisses the proposal.",
    ].join("\n"),

    [
      "## Hard exclusions (non-negotiable)",
      "- Never prescribe fixed study allotments, recurring slots, countdown pressure, completion targets or gamified pressure.",
      "- Never attach pacing metadata of any kind to a path, module or node.",
      "- Never order nodes by external pacing; order only by conceptual dependency.",
      "- Never imply that a learner is behind or must catch up.",
      "Learning speed is nonlinear, so the path stays a dependency map rather than a plan of dates.",
    ].join("\n"),

    [
      "## Output contract",
      "Call save_learning_path with a draft object containing title, goal, sourceSpine and modules. Each module needs a title and nodes; each node needs type, title, goal and a sourceAnchor OBJECT with a reference title and optionally chapter, section or pages.",
      "For a new path, omit path/module/node ids, timestamps, progression, interleavesNodeIds, childSessions, errors and pivotSuggestions. The server fills those in, including links to preceding nodes. An example new node: {\"type\":\"concept\",\"title\":\"Hash functions\",\"goal\":\"Explain why hashes appear irregular\",\"sourceAnchor\":{\"reference\":\"The Book of Shaders\",\"chapter\":\"Random\"}}.",
      "For refinement, first call get_learning_path to read the current outline with its path, module and node ids, then save the full outline including every existing id. Learner state on existing nodes (progression, child sessions, errors, pivots) is always preserved by the server. Do not invent ids for an existing path.",
      "For an outline with several nodes, prefer save_learning_path_json: supply the entire draft as one valid JSON string in draftJson. For small drafts, save_learning_path accepts structured arguments. If nested modules are serialized as a string or a tool call fails to parse, switch to save_learning_path_json; do not retry hand-written XML/DSML tags. Never print tool-call tags or JSON code blocks in the conversation. If validation fails, correct the indicated field before retrying.",
    ].join("\n"),
  ];

  if (existingPath) sections.push(refinementLines(existingPath));
  return sections.join("\n\n");
}

/** Resolve the artifact a child session should prompt for, in override order. */
export function resolveNodeArtifact(
  path: LearningPath,
  node: PathNode,
  settings: PluginSettings | null = null,
): ArtifactConfig {
  if (node.artifactConfig) return node.artifactConfig;
  if (path.artifactDefault) return { type: path.artifactDefault };
  const fromSettings = settings?.artifactDefaults[node.type];
  if (fromSettings) return { type: fromSettings };
  return { type: defaultArtifactFor(node.type) };
}

export interface ErrorWatchpoint {
  readonly nodeId: string;
  readonly nodeTitle: string;
  readonly entry: ErrorEntry;
}

export interface ChildSessionBriefInput {
  readonly path: LearningPath;
  readonly nodeId: string;
  readonly kind: ChildSessionKind;
  readonly settings?: PluginSettings | null;
  /** Optional override for the loose priming hook; a loose suggestion either way. */
  readonly primingHook?: string;
}

export interface ChildSessionBrief {
  readonly text: string;
  readonly node: PathNode;
  readonly artifact: ArtifactConfig;
  readonly interleavedNodes: readonly PathNode[];
  readonly watchpoints: readonly ErrorWatchpoint[];
}

const WATCHPOINT_LIMIT = 8;

/** Unresolved errors that follow a node: its own, its interleaved predecessors',
 * then the nearest upstream nodes. The limit keeps a child brief bounded. */
export function collectErrorWatchpoints(
  path: LearningPath,
  nodeId: string,
  limit: number = WATCHPOINT_LIMIT,
): readonly ErrorWatchpoint[] {
  if (limit <= 0) return [];
  const ordered = path.modules.flatMap((module) => module.nodes);
  const node = ordered.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new DomainValidationError([{ path: "nodeId", message: `unknown node id "${nodeId}"` }]);
  }
  const index = ordered.indexOf(node);
  const upstream = ordered.slice(0, index);
  const interleavedNodes = node.interleavesNodeIds
    .map((id) => ordered.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is PathNode => candidate !== undefined);

  const seenNodes = new Set<string>();
  const watchSources: PathNode[] = [];
  for (const candidate of [node, ...interleavedNodes, ...[...upstream].reverse()]) {
    if (seenNodes.has(candidate.id)) continue;
    seenNodes.add(candidate.id);
    watchSources.push(candidate);
  }
  const watchpoints: ErrorWatchpoint[] = [];
  for (const source of watchSources) {
    for (const entry of source.errors) {
      if (entry.resolved) continue;
      watchpoints.push({ nodeId: source.id, nodeTitle: source.title, entry });
      if (watchpoints.length === limit) return watchpoints;
    }
  }
  return watchpoints;
}

/** Compose the brief for a child teaching/practice session linked to one node. */
export function buildChildSessionBrief(input: ChildSessionBriefInput): ChildSessionBrief {
  const { path, nodeId, kind } = input;
  const ordered = path.modules.flatMap((module) => module.nodes);
  const node = ordered.find((candidate) => candidate.id === nodeId);
  if (!node) {
    throw new DomainValidationError([{ path: "nodeId", message: `unknown node id "${nodeId}"` }]);
  }
  const index = ordered.indexOf(node);
  const upstream = ordered.slice(0, index);
  const interleavedNodes = node.interleavesNodeIds
    .map((id) => ordered.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is PathNode => candidate !== undefined);

  const watchpoints = collectErrorWatchpoints(path, nodeId);

  const artifact = resolveNodeArtifact(path, node, input.settings ?? null);
  const catalog = artifactCatalogEntry(artifact.type);
  const anchor = formatSourceAnchor(node.sourceAnchor);
  const guide = nodeGuide(node.type);

  const interleavingLines =
    interleavedNodes.length === 0
      ? ["No earlier node is linked for this node yet; keep the examples varied inside this session and connect back to the module's holistic node when one exists."]
      : interleavedNodes.map(
          (earlier) =>
            `- ${earlier.title} (${earlier.type}): re-surface it briefly and use it inside at least one example or question, without a heading that labels which idea applies.`,
        );

  const watchpointLines =
    watchpoints.length === 0
      ? ["No unresolved error is on record. Probe for gaps anyway; log what you find with the learning_path tools."]
      : watchpoints.map(
          (watchpoint) =>
            `- [${watchpoint.entry.category}] ${watchpoint.entry.summary} (from "${watchpoint.nodeTitle}", still unresolved) — verify quietly whether the repair held.`,
        );

  const artifactLines = [
    `Recommended: ${catalog.label} (${catalog.type}).`,
    `Why the framework recommends this: ${catalog.justification}`,
    ...(artifact.instructions === undefined
      ? []
      : [`Node-specific framing: ${artifact.instructions}`]),
    'Respect "none" if the learner prefers conversation-only, and do not present the artifact as a gate.',
  ];

  const text = [
    "# Learning Path child session brief",
    `You are opening a ${kind} session for one node of the learner's learning path "${path.title}".`,
    `Path goal: ${path.goal}`,
    "",
    "## Node",
    `${node.title} (${node.type}: ${guide.label})`,
    `Goal: ${node.goal}`,
    `Progression: ${node.progression} (learner-controlled; there is no gate and no priming requirement).`,
    "",
    "## Source anchor",
    `Spine: ${formatSourceSpine(path.sourceSpine)}`,
    `Anchor: ${anchor}`,
    "Stay inside this anchor and this spine's notation; do not substitute a different curriculum.",
    "",
    "## Light pre-reading (self-directed, optional)",
    node.lightPreReading ??
      "No pre-reading pointer is set for this node. If orientation would help, suggest one short self-directed skim; never make it a requirement.",
    "",
    "## Loose micro-priming (recommended, never a gate)",
    input.primingHook ?? microPrimingHookFor(node.type),
    "Treat this as one possible hook: offer it once, accept a skip immediately, and move on to the node's goal.",
    "",
    "## Meso-interleaving callbacks",
    ...interleavingLines,
    "Keep micro-interleaving inside this session by mixing edge cases, non-examples and variations.",
    "",
    "## Active error watchpoints",
    ...watchpointLines,
    "",
    "## Generative artifact",
    ...artifactLines,
    "",
    "## Reporting back",
    "Use learning_path_update_progress as understanding consolidates, learning_path_log_error for each diagnosed root cause, and learning_path_suggest_pivot only when a topic is not sticking for a specific reason.",
    "Never restructure the path yourself; the learner decides.",
  ].join("\n");

  return { text, node, artifact, interleavedNodes, watchpoints };
}
