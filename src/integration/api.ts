/** Learning Path companion integration — API v1 contract.
 *
 * The read-only surface that companion plugins build against: paths, modules
 * and nodes, workspace item metadata with bounded note reads, unresolved
 * error-ledger watchpoints and pending advisory pivots. Everything is a
 * snapshot; there is no subscription, no write and no scheduling semantics.
 *
 * This module is intentionally self-contained: no imports and no runtime code
 * beyond the error class, so it can ship as a type-only package while
 * `./reader.ts` provides the default file-store implementation. Companion
 * plugins join on the stable ids exposed here and write anything they produce
 * into their own `ctx.dataDirectory`, never into the Learning Path store.
 *
 * Versioning: `INTEGRATION_API_VERSION` bumps are breaking; new capabilities
 * may appear within a version, so callers should consult `getCapabilities()`
 * rather than assuming the full list. A newer Learning Path *store* schema
 * surfaces as an `unsupportedVersion` error, never as guesses or partial data.
 */

export const INTEGRATION_API_VERSION = 1 as const;

/** The Learning Path store schema this integration reads. Bump together with
 * the plugin's `STORE_SCHEMA_VERSION`; readers fail loud on anything else. */
export const SUPPORTED_STORE_SCHEMA_VERSION = 1 as const;

/** Functional areas this integration can serve, reported by
 * `getCapabilities()`. A capability is absent only when the backing data
 * cannot serve it at all (e.g. no store on disk) — never per-path. */
export type LearningPathCapability =
  | "paths"
  | "structure"
  | "workspace"
  | "errors"
  | "pivots";

/** The six proactive node types from the framework. */
export type IntegrationNodeType =
  | "holistic"
  | "concept"
  | "contrast"
  | "skill"
  | "checkpoint"
  | "bridge";

/** Ungated progression states; honest inventory, never a completion target. */
export type IntegrationProgression = "unstarted" | "in_progress" | "consolidated";

/** Cognitive root-cause categories from the Error Ledger. */
export type IntegrationErrorCategory =
  | "misconception"
  | "discrimination_error"
  | "prerequisite_gap"
  | "procedural_slip"
  | "cue_failure";

/** One path's card: everything a companion needs to list, group or filter. */
export interface LearningPathSummary {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly updatedAt: string;
  readonly sourceMode: "canonical" | "uploaded";
  /** Spine titles: canonical references or uploaded corpus names. */
  readonly sourceTitles: readonly string[];
  readonly moduleCount: number;
  readonly nodeCount: number;
  readonly nodeStates: Readonly<Record<IntegrationProgression, number>>;
  readonly pendingPivotCount: number;
  readonly unresolvedErrorCount: number;
  /** Learner-owned filing metadata; empty means none. */
  readonly tags: readonly string[];
  /** The path's one folder home, or null when unfiled. */
  readonly folder: string | null;
}

/** A module: the unit of grouping inside a path. */
export interface ModuleSummary {
  readonly id: string;
  readonly title: string;
  readonly goal?: string;
  readonly nodeCount: number;
}

/** A node's inventory row. Cheap to list in bulk. */
export interface NodeSummary {
  readonly id: string;
  readonly moduleId: string;
  readonly type: IntegrationNodeType;
  readonly title: string;
  readonly goal: string;
  readonly progression: IntegrationProgression;
  readonly sourceAnchor: {
    readonly reference: string;
    readonly chapter?: string;
    readonly section?: string;
    readonly pages?: string;
  };
  readonly unresolvedErrorCount: number;
  readonly pendingPivotCount: number;
  readonly childSessionCount: number;
}

/** Full node context for companions that drill into one node. */
export interface NodeDetail extends NodeSummary {
  /** Self-directed orientation pointer, when the node has one. */
  readonly lightPreReading?: string;
  /** Meso-interleaving callbacks: earlier node ids woven into this node. */
  readonly interleavesNodeIds: readonly string[];
  /** Resolved against per-node, path and plugin defaults, in that order. */
  readonly artifactType: string;
  /** Learner note recorded when a child session completed the artifact. */
  readonly artifactNote?: string;
  /** Linked child sessions; `chatId` joins against host session events. */
  readonly childSessions: readonly {
    readonly chatId: string;
    readonly kind: "teaching" | "practice";
    readonly label: string;
    readonly createdAt: string;
  }[];
}

/** Workspace item metadata. Content is read only through the bounded
 * `readWorkspaceItem`, mirroring the plugin's own chunked viewer. */
export interface WorkspaceItemRef {
  readonly id: string;
  readonly kind: "note" | "session_artifact" | "source" | "code";
  readonly title: string;
  readonly addedAt: string;
  /** "learner" | "architect:<chatId>" | "session:<chatId>" — provenance only. */
  readonly addedBy: string;
  readonly caption?: string;
  /** Node ids this item is filed against (or "space" for workspace-level). */
  readonly links: readonly { readonly to: string; readonly rel: "grounds" | "informs" | "produced_by" }[];
  readonly byteSize?: number;
  /** UUID item ids name their content file; never used for other kinds. */
  readonly sourceId?: string;
}

/** One bounded Markdown read. `nextOffset` present means more content exists. */
export interface WorkspaceItemChunk {
  readonly text: string;
  readonly nextOffset: number | null;
}

/** An unresolved Error Ledger entry, ready to travel forward as a watchpoint. */
export interface OpenErrorRef {
  readonly id: string;
  readonly nodeId: string;
  readonly category: IntegrationErrorCategory;
  readonly summary: string;
  /** Learner-written reflection, when one was added. */
  readonly notes?: string;
  readonly createdAt: string;
  /** Native chat where the friction was observed, when known. */
  readonly sessionChatId?: string;
}

/** A pending advisory pivot; suggest, never enforce. */
export interface PendingPivotRef {
  readonly id: string;
  readonly nodeId: string;
  readonly proposalType: "bridge" | "contrast" | "skill" | "holistic";
  readonly title: string;
  readonly rationale: string;
}

export type IntegrationErrorCode =
  | "storeNotFound"
  | "unsupportedVersion"
  | "corruptRecord";

/** Thrown for store-level failures so a broken or upgraded Learning Path
 * install is loud rather than silently empty. Unknown paths and nodes are
 * `null` returns, not errors. */
export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;

  constructor(code: IntegrationErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "IntegrationError";
    this.code = code;
  }
}

/** The v1 companion surface. */
export interface LearningPathIntegration {
  readonly apiVersion: 1;

  /** Capabilities served by the backing store; empty before any data exists. */
  getCapabilities(): readonly LearningPathCapability[];

  listPaths(): readonly LearningPathSummary[];
  getPath(pathId: string): LearningPathSummary | null;

  listModules(pathId: string): readonly ModuleSummary[] | null;
  listNodes(pathId: string, moduleId?: string): readonly NodeSummary[] | null;
  getNode(pathId: string, nodeId: string): NodeDetail | null;

  /** Item metadata, optionally filtered to one node via `links.to`.
   * Paths with no materialized workspace read as an empty list. */
  listWorkspaceItems(
    pathId: string,
    filter?: { readonly nodeId?: string; readonly kind?: WorkspaceItemRef["kind"] },
  ): readonly WorkspaceItemRef[] | null;

  /** Bounded Markdown content read; null for unknown items, workspace-less
   * paths, source-kind items (reference the Learning Path sources store) or
   * items with no content file. UTF-8 byte offsets; `maxBytes` defaults to
   * 32 KiB and is capped at 256 KiB. */
  readWorkspaceItem(
    pathId: string,
    itemId: string,
    range?: { readonly offset?: number; readonly maxBytes?: number },
  ): WorkspaceItemChunk | null;

  listOpenErrors(pathId: string, nodeId?: string): readonly OpenErrorRef[] | null;
  listPendingPivots(pathId: string): readonly PendingPivotRef[] | null;
}

/** Options for the default file-store implementation. */
export interface FileStoreIntegrationOptions {
  /** Absolute path to the Learning Path plugin's data directory
   * (`.../learning-path/data`). Never a symlink-followed guess: the store
   * itself refuses symlinks and so does the reader. */
  readonly dataDirectory: string;
}
