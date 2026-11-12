/** Learning Path — domain schema and runtime validation.
 *
 * Pure data: no Node or browser imports, so the same validators serve the backend
 * Architect tool, the store and (via the bundle) any future frontend checks.
 * Unknown keys are ignored on read; every value that crosses into a `LearningPath`
 * is checked here, and validated records are rebuilt without unknown keys so the
 * store never persists arbitrary JSON.
 */

export const NODE_TYPES = ["holistic", "concept", "contrast", "skill", "checkpoint", "bridge"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Ungated epistemic progression. There is deliberately no `primed` gate. */
export const PROGRESSION_STATES = ["unstarted", "in_progress", "consolidated"] as const;
export type ProgressionState = (typeof PROGRESSION_STATES)[number];

export const CHILD_SESSION_KINDS = ["teaching", "practice"] as const;
export type ChildSessionKind = (typeof CHILD_SESSION_KINDS)[number];

/** Cognitive root causes, never numeric grades. */
export const ERROR_CATEGORIES = [
  "misconception",
  "discrimination_error",
  "prerequisite_gap",
  "procedural_slip",
  "cue_failure",
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const PIVOT_STATUSES = ["pending", "accepted", "dismissed"] as const;
export type PivotStatus = (typeof PIVOT_STATUSES)[number];

/** Pivots repair a diagnosed gap; they never restructure the path on their own. */
export const PIVOT_PROPOSAL_TYPES = ["bridge", "contrast", "skill", "holistic"] as const;
export type PivotProposalType = (typeof PIVOT_PROPOSAL_TYPES)[number];

/** Thinking levels accepted by the host model catalog. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

export const ARTIFACT_TYPES = [
  "micro_code",
  "relational_map",
  "encoding_exercise",
  "derivation_trace",
  "retrieval_cue",
  "none",
] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface ArtifactCatalogEntry {
  readonly type: ArtifactType;
  readonly label: string;
  /** Node types the framework recommends this artifact for, best first. */
  readonly bestFor: readonly NodeType[];
  /** Shown verbatim in the UI ("Why the framework recommends this"). */
  readonly justification: string;
}

/** The justified artifact catalog from FRAMEWORK.md principle 6. */
export const ARTIFACT_CATALOG: readonly ArtifactCatalogEntry[] = [
  {
    type: "micro_code",
    label: "Micro-code / implementation",
    bestFor: ["concept", "skill", "checkpoint"],
    justification:
      "Eliminates hand-waving: a small interpreter, compiler or test case exposes hidden assumptions and edge-case gaps immediately.",
  },
  {
    type: "relational_map",
    label: "Relational map / diagram",
    bestFor: ["holistic", "contrast"],
    justification:
      "Externalizes mental structure: forcing explicit node-and-edge labels reveals whether you understand the actual causal or logical links or merely know that two terms are related.",
  },
  {
    type: "encoding_exercise",
    label: "Encoding / compression exercise",
    bestFor: ["concept", "contrast", "bridge"],
    justification:
      "Harnesses the generation effect: reconstructing and compressing an idea in your own words (blank-page Feynman, compare/contrast matrix, counterexample design) creates retrieval pathways that passive review cannot.",
  },
  {
    type: "derivation_trace",
    label: "Derivation / worked trace",
    bestFor: ["concept", "skill"],
    justification:
      "Verifies step-by-step causal continuity without relying on the textbook's visual scaffolding.",
  },
  {
    type: "retrieval_cue",
    label: "Retrieval cue / flashcard seed",
    bestFor: ["skill"],
    justification:
      "Crystallizes atomic hooks and heuristics after comprehension is established so tactical fluency stays sharp.",
  },
  {
    type: "none",
    label: "None / conversation-only",
    bestFor: [...NODE_TYPES],
    justification:
      "Conversation alone is a legitimate choice; keep it when a learner prefers dialogue, while remembering that no generated artifact means less protection against the illusion of competence.",
  },
];

export function artifactCatalogEntry(type: ArtifactType): ArtifactCatalogEntry {
  const entry = ARTIFACT_CATALOG.find((candidate) => candidate.type === type);
  if (!entry) throw new Error(`Unknown artifact type: ${String(type)}`);
  return entry;
}

/** Framework recommendations for a node type, best first; `none` when nothing applies. */
export function recommendedArtifactsFor(nodeType: NodeType): readonly ArtifactType[] {
  const recommended = ARTIFACT_CATALOG.filter(
    (entry) => entry.type !== "none" && entry.bestFor.includes(nodeType),
  ).map((entry) => entry.type);
  return recommended.length > 0 ? recommended : ["none"];
}

/** The framework's fallback when neither node, path nor settings choose an artifact. */
export function defaultArtifactFor(nodeType: NodeType): ArtifactType {
  return recommendedArtifactsFor(nodeType)[0] ?? "none";
}

export interface ArtifactConfig {
  readonly type: ArtifactType;
  /** Optional per-node framing; the catalog justification always accompanies it. */
  readonly instructions?: string;
}

export interface SourceAnchor {
  /** Title of the canonical reference or uploaded source this node is anchored to. */
  readonly reference: string;
  readonly chapter?: string;
  readonly section?: string;
  readonly pages?: string;
}

export interface CanonicalReference {
  readonly title: string;
  readonly author?: string;
  readonly edition?: string;
  readonly kind: "textbook" | "course" | "specification";
}

export interface UploadedSourceReference {
  readonly sourceId: string;
  readonly name: string;
  readonly uploadedAt: string;
  readonly byteSize?: number;
  readonly sha256?: string;
}

/** Canon mode anchors to canon; uploaded mode builds from the learner's corpus.
 * `supplements` on either side patch a missing prerequisite without changing mode. */
export type SourceSpine =
  | {
      readonly mode: "canonical";
      readonly references: readonly CanonicalReference[];
      readonly supplements?: readonly UploadedSourceReference[];
    }
  | {
      readonly mode: "uploaded";
      readonly sources: readonly UploadedSourceReference[];
      readonly supplements?: readonly CanonicalReference[];
    };

export interface ChildSessionLink {
  readonly chatId: string;
  readonly kind: ChildSessionKind;
  readonly createdAt: string;
  readonly label: string;
}

export interface ErrorEntry {
  readonly id: string;
  readonly category: ErrorCategory;
  readonly summary: string;
  readonly resolved: boolean;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  /** Learner-written reflection added from the Error Ledger. */
  readonly notes?: string;
  /** Native chat where the friction was observed, when known. */
  readonly sessionChatId?: string;
}

export interface PivotSuggestion {
  readonly id: string;
  readonly status: PivotStatus;
  readonly proposalType: PivotProposalType;
  readonly title: string;
  readonly rationale: string;
  readonly createdAt: string;
  readonly resolvedAt?: string;
  /** Set when the learner accepted the pivot and the node was inserted. */
  readonly insertedNodeId?: string;
}

export interface PathNode {
  readonly id: string;
  readonly type: NodeType;
  readonly title: string;
  readonly goal: string;
  readonly sourceAnchor: SourceAnchor;
  /** Self-directed orientation outside chat; replaces macro-priming chats. */
  readonly lightPreReading?: string;
  /** Meso-interleaving callbacks: earlier nodes to weave into this one. */
  readonly interleavesNodeIds: readonly string[];
  readonly progression: ProgressionState;
  /** Per-node override; absent or null inherits the path/plugin default. */
  readonly artifactConfig?: ArtifactConfig | null;
  /** Optional learner note recorded when a child session completes the artifact. */
  readonly artifactNote?: string;
  readonly childSessions: readonly ChildSessionLink[];
  readonly errors: readonly ErrorEntry[];
  readonly pivotSuggestions: readonly PivotSuggestion[];
}

export interface PathModule {
  readonly id: string;
  readonly title: string;
  readonly goal?: string;
  readonly nodes: readonly PathNode[];
}

export interface LearningPath {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly sourceSpine: SourceSpine;
  readonly modules: readonly PathModule[];
  /** Path-level artifact preference; per-node overrides win. */
  readonly artifactDefault?: ArtifactType | null;
  /** Architect conversation that created/refines this path. */
  readonly architectChatId?: string | null;
}

/** Architect model preference: follow the host strong slot or override explicitly. */
export interface ArchitectPreferences {
  readonly followHostSlot: boolean;
  /** Required when `followHostSlot` is false. */
  readonly model?: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: ThinkingLevelName;
}

export interface PluginSettings {
  /** Explicit per-node-type defaults; absent entries fall back to the catalog. */
  readonly artifactDefaults: Partial<Record<NodeType, ArtifactType>>;
  /** Absent means follow the host strong slot, the default. */
  readonly architect?: ArchitectPreferences;
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export class DomainValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "DomainValidationError";
    this.issues = issues;
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Uploaded source ids name files under `sources/`; UUIDs keep them unguessable and traversal-free. */
const SOURCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSourceId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_ID_PATTERN.test(value);
}
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function fail(path: string, message: string): never {
  throw new DomainValidationError([{ path, message }]);
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function readString(
  value: unknown,
  path: string,
  { max = 4000, min = 1 }: { max?: number; min?: number } = {},
): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value !== value.trim()) fail(path, "must not have leading or trailing whitespace");
  if (value.length < min) fail(path, `must be at least ${min} character(s)`);
  if (value.length > max) fail(path, `must be at most ${max} characters`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) {
    fail(path, "must not contain control characters");
  }
  return value;
}

function readOptionalString(
  value: unknown,
  path: string,
  options?: { max?: number; min?: number },
): string | undefined {
  return value === undefined ? undefined : readString(value, path, options);
}

function readId(value: unknown, path: string): string {
  const id = readString(value, path, { max: 128 });
  if (!ID_PATTERN.test(id)) fail(path, "must be an id: letters, digits, '.', '_', ':' or '-'");
  return id;
}

function readTimestamp(value: unknown, path: string): string {
  const stamp = readString(value, path, { max: 32 });
  if (!TIMESTAMP_PATTERN.test(stamp) || !Number.isFinite(Date.parse(stamp))) {
    fail(path, "must be an ISO-8601 UTC timestamp such as 2026-01-31T09:30:00.000Z");
  }
  return stamp;
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function readInteger(value: unknown, path: string, { min = 0 }: { min?: number } = {}): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) fail(path, `must be an integer >= ${min}`);
  return value as number;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function readArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function readStringArray(
  value: unknown,
  path: string,
  read: (entry: unknown, path: string) => string,
): readonly string[] {
  const entries = readArray(value, path);
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const parsed = read(entry, `${path}[${index}]`);
    if (seen.has(parsed)) fail(`${path}[${index}]`, `duplicate value "${parsed}"`);
    seen.add(parsed);
    return parsed;
  });
}

function readSourceAnchor(value: unknown, path: string): SourceAnchor {
  const record = readObject(value, path);
  const anchor: SourceAnchor = {
    reference: readString(record.reference, `${path}.reference`, { max: 200 }),
    ...(record.chapter === undefined
      ? {}
      : { chapter: readString(record.chapter, `${path}.chapter`, { max: 120 }) }),
    ...(record.section === undefined
      ? {}
      : { section: readString(record.section, `${path}.section`, { max: 120 }) }),
    ...(record.pages === undefined
      ? {}
      : { pages: readString(record.pages, `${path}.pages`, { max: 120 }) }),
  };
  return anchor;
}

function readArtifactConfig(value: unknown, path: string): ArtifactConfig {
  const record = readObject(value, path);
  return {
    type: readEnum(record.type, ARTIFACT_TYPES, `${path}.type`),
    ...(record.instructions === undefined
      ? {}
      : { instructions: readString(record.instructions, `${path}.instructions`, { max: 2000 }) }),
  };
}

function readCanonicalReference(value: unknown, path: string): CanonicalReference {
  const record = readObject(value, path);
  return {
    title: readString(record.title, `${path}.title`, { max: 300 }),
    ...(record.author === undefined
      ? {}
      : { author: readString(record.author, `${path}.author`, { max: 200 }) }),
    ...(record.edition === undefined
      ? {}
      : { edition: readString(record.edition, `${path}.edition`, { max: 120 }) }),
    kind: readEnum(record.kind, ["textbook", "course", "specification"] as const, `${path}.kind`),
  };
}

function readUploadedSourceReference(value: unknown, path: string): UploadedSourceReference {
  const record = readObject(value, path);
  const sha256 = readOptionalString(record.sha256, `${path}.sha256`, { max: 64, min: 64 });
  if (sha256 !== undefined && !SHA256_PATTERN.test(sha256)) {
    fail(`${path}.sha256`, "must be a lowercase hex SHA-256 digest");
  }
  const sourceId = readString(record.sourceId, `${path}.sourceId`, { max: 128 });
  if (!isSourceId(sourceId)) fail(`${path}.sourceId`, "must be a UUID");
  return {
    sourceId,
    name: readString(record.name, `${path}.name`, { max: 300 }),
    uploadedAt: readTimestamp(record.uploadedAt, `${path}.uploadedAt`),
    ...(record.byteSize === undefined
      ? {}
      : { byteSize: readInteger(record.byteSize, `${path}.byteSize`) }),
    ...(sha256 === undefined ? {} : { sha256 }),
  };
}

/** Validate one uploaded-source reference, throwing `DomainValidationError`.
 * The store uses it for `sources/index.json` so metadata cannot drift from the
 * schema a `LearningPath` already enforces. */
export function parseUploadedSourceReference(value: unknown): UploadedSourceReference {
  return readUploadedSourceReference(value, "source");
}

function readSourceReferences<T>(
  value: unknown,
  path: string,
  read: (entry: unknown, path: string) => T,
  identity: (entry: T) => string,
): readonly T[] {
  const entries = readArray(value, path);
  if (entries.length === 0) fail(path, "must contain at least one entry");
  const seen = new Set<string>();
  return entries.map((entry, index) => {
    const parsed = read(entry, `${path}[${index}]`);
    const key = identity(parsed);
    if (seen.has(key)) fail(`${path}[${index}]`, `duplicate entry "${key}"`);
    seen.add(key);
    return parsed;
  });
}

function readSourceSpine(value: unknown, path: string): SourceSpine {
  const record = readObject(value, path);
  const mode = readEnum(record.mode, ["canonical", "uploaded"] as const, `${path}.mode`);
  if (mode === "canonical") {
    return {
      mode,
      references: readSourceReferences(
        record.references,
        `${path}.references`,
        readCanonicalReference,
        (entry) => entry.title,
      ),
      ...(record.supplements === undefined
        ? {}
        : {
            supplements: readSourceReferences(
              record.supplements,
              `${path}.supplements`,
              readUploadedSourceReference,
              (entry) => entry.sourceId,
            ),
          }),
    };
  }
  return {
    mode,
    sources: readSourceReferences(
      record.sources,
      `${path}.sources`,
      readUploadedSourceReference,
      (entry) => entry.sourceId,
    ),
    ...(record.supplements === undefined
      ? {}
      : {
          supplements: readSourceReferences(
            record.supplements,
            `${path}.supplements`,
            readCanonicalReference,
            (entry) => entry.title,
          ),
        }),
  };
}

function readChildSessionLink(value: unknown, path: string): ChildSessionLink {
  const record = readObject(value, path);
  return {
    chatId: readId(record.chatId, `${path}.chatId`),
    kind: readEnum(record.kind, CHILD_SESSION_KINDS, `${path}.kind`),
    createdAt: readTimestamp(record.createdAt, `${path}.createdAt`),
    label: readString(record.label, `${path}.label`, { max: 200 }),
  };
}

function readErrorEntry(value: unknown, path: string): ErrorEntry {
  const record = readObject(value, path);
  const resolved = readBoolean(record.resolved, `${path}.resolved`);
  const resolvedAt = readOptionalString(record.resolvedAt, `${path}.resolvedAt`, { max: 32 });
  if (resolvedAt !== undefined) readTimestamp(resolvedAt, `${path}.resolvedAt`);
  if (resolved && resolvedAt === undefined) {
    fail(path, "a resolved error needs resolvedAt");
  }
  if (!resolved && resolvedAt !== undefined) {
    fail(path, "an unresolved error must not carry resolvedAt");
  }
  return {
    id: readId(record.id, `${path}.id`),
    category: readEnum(record.category, ERROR_CATEGORIES, `${path}.category`),
    summary: readString(record.summary, `${path}.summary`, { max: 2000 }),
    resolved,
    createdAt: readTimestamp(record.createdAt, `${path}.createdAt`),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(record.notes === undefined
      ? {}
      : { notes: readString(record.notes, `${path}.notes`, { max: 2000 }) }),
    ...(record.sessionChatId === undefined
      ? {}
      : { sessionChatId: readId(record.sessionChatId, `${path}.sessionChatId`) }),
  };
}

function readPivotSuggestion(value: unknown, path: string): PivotSuggestion {
  const record = readObject(value, path);
  const status = readEnum(record.status, PIVOT_STATUSES, `${path}.status`);
  const resolvedAt = readOptionalString(record.resolvedAt, `${path}.resolvedAt`, { max: 32 });
  if (resolvedAt !== undefined) readTimestamp(resolvedAt, `${path}.resolvedAt`);
  if (status === "pending" && resolvedAt !== undefined) {
    fail(path, "a pending pivot must not carry resolvedAt");
  }
  if (status !== "pending" && resolvedAt === undefined) {
    fail(path, `a ${status} pivot needs resolvedAt`);
  }
  return {
    id: readId(record.id, `${path}.id`),
    status,
    proposalType: readEnum(record.proposalType, PIVOT_PROPOSAL_TYPES, `${path}.proposalType`),
    title: readString(record.title, `${path}.title`, { max: 300 }),
    rationale: readString(record.rationale, `${path}.rationale`, { max: 2000 }),
    createdAt: readTimestamp(record.createdAt, `${path}.createdAt`),
    ...(resolvedAt === undefined ? {} : { resolvedAt }),
    ...(record.insertedNodeId === undefined
      ? {}
      : { insertedNodeId: readId(record.insertedNodeId, `${path}.insertedNodeId`) }),
  };
}

function readPathNode(value: unknown, path: string): PathNode {
  const record = readObject(value, path);
  return {
    id: readId(record.id, `${path}.id`),
    type: readEnum(record.type, NODE_TYPES, `${path}.type`),
    title: readString(record.title, `${path}.title`, { max: 300 }),
    goal: readString(record.goal, `${path}.goal`, { max: 4000 }),
    sourceAnchor: readSourceAnchor(record.sourceAnchor, `${path}.sourceAnchor`),
    ...(record.lightPreReading === undefined
      ? {}
      : {
          lightPreReading: readString(record.lightPreReading, `${path}.lightPreReading`, {
            max: 1000,
          }),
        }),
    interleavesNodeIds: readStringArray(
      record.interleavesNodeIds,
      `${path}.interleavesNodeIds`,
      readId,
    ),
    progression: readEnum(record.progression, PROGRESSION_STATES, `${path}.progression`),
    ...(record.artifactConfig === undefined
      ? {}
      : {
          artifactConfig:
            record.artifactConfig === null
              ? null
              : readArtifactConfig(record.artifactConfig, `${path}.artifactConfig`),
        }),
    ...(record.artifactNote === undefined
      ? {}
      : { artifactNote: readString(record.artifactNote, `${path}.artifactNote`, { max: 2000 }) }),
    childSessions: readArray(record.childSessions, `${path}.childSessions`).map((entry, index) =>
      readChildSessionLink(entry, `${path}.childSessions[${index}]`),
    ),
    errors: readArray(record.errors, `${path}.errors`).map((entry, index) =>
      readErrorEntry(entry, `${path}.errors[${index}]`),
    ),
    pivotSuggestions: readArray(record.pivotSuggestions, `${path}.pivotSuggestions`).map(
      (entry, index) => readPivotSuggestion(entry, `${path}.pivotSuggestions[${index}]`),
    ),
  };
}

function readPathModule(value: unknown, path: string): PathModule {
  const record = readObject(value, path);
  const nodes = readArray(record.nodes, `${path}.nodes`);
  if (nodes.length === 0) fail(`${path}.nodes`, "a module needs at least one node");
  return {
    id: readId(record.id, `${path}.id`),
    title: readString(record.title, `${path}.title`, { max: 300 }),
    ...(record.goal === undefined
      ? {}
      : { goal: readString(record.goal, `${path}.goal`, { max: 4000 }) }),
    nodes: nodes.map((entry, index) => readPathNode(entry, `${path}.nodes[${index}]`)),
  };
}

function readLearningPathValue(value: unknown): LearningPath {
  const path = "path";
  const record = readObject(value, path);
  const modules = readArray(record.modules, `${path}.modules`);
  if (modules.length === 0) fail(`${path}.modules`, "a path needs at least one module");
  const parsedModules = modules.map((entry, index) =>
    readPathModule(entry, `${path}.modules[${index}]`),
  );
  const parsed: LearningPath = {
    id: readId(record.id, `${path}.id`),
    title: readString(record.title, `${path}.title`, { max: 300 }),
    goal: readString(record.goal, `${path}.goal`, { max: 4000 }),
    createdAt: readTimestamp(record.createdAt, `${path}.createdAt`),
    updatedAt: readTimestamp(record.updatedAt, `${path}.updatedAt`),
    sourceSpine: readSourceSpine(record.sourceSpine, `${path}.sourceSpine`),
    modules: parsedModules,
    ...(record.artifactDefault === undefined || record.artifactDefault === null
      ? { artifactDefault: record.artifactDefault }
      : {
          artifactDefault: readEnum(
            record.artifactDefault,
            ARTIFACT_TYPES,
            `${path}.artifactDefault`,
          ),
        }),
    ...(record.architectChatId === undefined || record.architectChatId === null
      ? { architectChatId: record.architectChatId }
      : { architectChatId: readId(record.architectChatId, `${path}.architectChatId`) }),
  };
  assertPathGraph(parsed);
  return parsed;
}

/** Ids are unique and every cross-reference resolves; a path is one graph, not a tree of typos. */
function assertPathGraph(path: LearningPath): void {
  const moduleIds = new Set<string>();
  const nodes = new Map<string, PathNode>();
  for (const module of path.modules) {
    if (moduleIds.has(module.id)) fail("path.modules", `duplicate module id "${module.id}"`);
    moduleIds.add(module.id);
    for (const node of module.nodes) {
      if (nodes.has(node.id)) fail("path.modules", `duplicate node id "${node.id}"`);
      nodes.set(node.id, node);
    }
  }
  for (const module of path.modules) {
    for (const node of module.nodes) {
      if (node.interleavesNodeIds.includes(node.id)) {
        fail(`node "${node.id}".interleavesNodeIds`, "must not reference the node itself");
      }
      for (const target of node.interleavesNodeIds) {
        if (!nodes.has(target)) {
          fail(`node "${node.id}".interleavesNodeIds`, `unknown node id "${target}"`);
        }
      }
      for (const pivot of node.pivotSuggestions) {
        if (pivot.insertedNodeId !== undefined && !nodes.has(pivot.insertedNodeId)) {
          fail(`node "${node.id}".pivotSuggestions`, `unknown inserted node id "${pivot.insertedNodeId}"`);
        }
      }
    }
  }
}

/** Validate a learning path without throwing; invalid input yields precise issues. */
export function validateLearningPath(value: unknown): ValidationResult<LearningPath> {
  try {
    return { ok: true, value: readLearningPathValue(value) };
  } catch (error) {
    if (error instanceof DomainValidationError) return { ok: false, issues: error.issues };
    throw error;
  }
}

/** Validate a learning path, throwing `DomainValidationError` with every issue found so far. */
export function parseLearningPath(value: unknown): LearningPath {
  return readLearningPathValue(value);
}

function readPluginSettingsValue(value: unknown): PluginSettings {
  const path = "settings";
  const record = readObject(value, path);
  const artifactDefaults: Partial<Record<NodeType, ArtifactType>> = {};
  if (record.artifactDefaults !== undefined) {
    const defaults = readObject(record.artifactDefaults, `${path}.artifactDefaults`);
    for (const [key, entry] of Object.entries(defaults)) {
      if (!(NODE_TYPES as readonly string[]).includes(key)) {
        fail(`${path}.artifactDefaults`, `unknown node type "${key}"`);
      }
      artifactDefaults[key as NodeType] = readEnum(
        entry,
        ARTIFACT_TYPES,
        `${path}.artifactDefaults.${key}`,
      );
    }
  }
  const architect =
    record.architect === undefined
      ? undefined
      : readArchitectPreferences(record.architect, `${path}.architect`);
  return {
    artifactDefaults,
    ...(architect === undefined ? {} : { architect }),
  };
}

/** Follow-host and the explicit override are mutually exclusive; neither is ambiguous. */
function readArchitectPreferences(value: unknown, path: string): ArchitectPreferences {
  const record = readObject(value, path);
  const followHostSlot =
    record.followHostSlot === undefined ? true : readBoolean(record.followHostSlot, `${path}.followHostSlot`);
  let model: { provider: string; id: string } | undefined;
  if (record.model !== undefined) {
    const choice = readObject(record.model, `${path}.model`);
    model = {
      provider: readString(choice.provider, `${path}.model.provider`, { max: 200 }),
      id: readString(choice.id, `${path}.model.id`, { max: 200 }),
    };
  }
  const thinkingLevel =
    record.thinkingLevel === undefined
      ? undefined
      : readEnum(record.thinkingLevel, THINKING_LEVELS, `${path}.thinkingLevel`);
  if (followHostSlot) {
    if (model !== undefined || thinkingLevel !== undefined) {
      fail(path, "must not carry a model or thinking level while following the host slot");
    }
    return { followHostSlot };
  }
  if (model === undefined) {
    fail(`${path}.model`, "is required when not following the host slot");
  }
  return {
    followHostSlot,
    model,
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
  };
}

export function validatePluginSettings(value: unknown): ValidationResult<PluginSettings> {
  try {
    return { ok: true, value: readPluginSettingsValue(value) };
  } catch (error) {
    if (error instanceof DomainValidationError) return { ok: false, issues: error.issues };
    throw error;
  }
}

export function parsePluginSettings(value: unknown): PluginSettings {
  return readPluginSettingsValue(value);
}

/** Human-readable anchor, e.g. `OSTEP — chapter 26, section 27.1, pages 301-320`. */
export function formatSourceAnchor(anchor: SourceAnchor): string {
  const parts = [
    anchor.chapter === undefined ? undefined : `chapter ${anchor.chapter}`,
    anchor.section === undefined ? undefined : `section ${anchor.section}`,
    anchor.pages === undefined ? undefined : `pages ${anchor.pages}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? anchor.reference : `${anchor.reference} — ${parts.join(", ")}`;
}
