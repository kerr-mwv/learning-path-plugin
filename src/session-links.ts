/** Learning Path — pure helpers for child-session links and diagnostic writes.
 *
 * The plugin owns the mapping from a native chat to a Path Node; the native chat
 * itself stays host-owned. Every helper returns a new `LearningPath` and never
 * mutates its input, so the store can validate and persist one atomic value.
 * Cross-path invariants (a chat is linked at most once) are checked by callers
 * that have all paths; the helpers check the single-path invariants.
 */
import { DomainValidationError } from "./domain.ts";
import type {
  ChildSessionKind,
  ChildSessionLink,
  ErrorCategory,
  ErrorEntry,
  LearningPath,
  PathNode,
  PivotProposalType,
  PivotSuggestion,
  ProgressionState,
} from "./domain.ts";

export interface ChatLinkLocation {
  readonly path: LearningPath;
  readonly node: PathNode;
  readonly link: ChildSessionLink;
}

export function orderedNodes(path: LearningPath): readonly PathNode[] {
  return path.modules.flatMap((module) => module.nodes);
}

export function findNode(path: LearningPath, nodeId: string): PathNode | null {
  return orderedNodes(path).find((node) => node.id === nodeId) ?? null;
}

/** Index of a node in path order; used to keep "upstream" checks honest. */
export function nodeIndex(path: LearningPath, nodeId: string): number {
  return orderedNodes(path).findIndex((node) => node.id === nodeId);
}

/** Find the single node a native chat is linked to, if any. */
export function findChatLink(
  paths: readonly LearningPath[],
  chatId: string,
): ChatLinkLocation | null {
  for (const path of paths) {
    for (const node of orderedNodes(path)) {
      const link = node.childSessions.find((candidate) => candidate.chatId === chatId);
      if (link) return { path, node, link };
    }
  }
  return null;
}

function replaceNode(
  path: LearningPath,
  nodeId: string,
  update: (node: PathNode) => PathNode,
  now: string,
): LearningPath {
  let found = false;
  const modules = path.modules.map((module) => ({
    ...module,
    nodes: module.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      found = true;
      return update(node);
    }),
  }));
  if (!found) {
    throw new DomainValidationError([{ path: "nodeId", message: `unknown node id "${nodeId}"` }]);
  }
  return { ...path, updatedAt: now, modules };
}

/** Append one child-session link; rejects a duplicate chat on the same node. */
export function addChildLink(
  path: LearningPath,
  nodeId: string,
  link: ChildSessionLink,
  now: string,
): LearningPath {
  return replaceNode(
    path,
    nodeId,
    (node) => {
      if (node.childSessions.some((candidate) => candidate.chatId === link.chatId)) {
        throw new DomainValidationError([
          {
            path: "chatId",
            message: `chat "${link.chatId}" is already linked to this node`,
          },
        ]);
      }
      return { ...node, childSessions: [...node.childSessions, link] };
    },
    now,
  );
}

/** Remove one child-session link; unknown chats are a no-op for retry safety. */
export function removeChildLink(
  path: LearningPath,
  nodeId: string,
  chatId: string,
  now: string,
): LearningPath {
  return replaceNode(
    path,
    nodeId,
    (node) => ({
      ...node,
      childSessions: node.childSessions.filter((candidate) => candidate.chatId !== chatId),
    }),
    now,
  );
}

export interface ProgressUpdate {
  readonly progression: ProgressionState;
  /** A short note recorded when the node's artifact was actually produced. */
  readonly artifactNote?: string;
}

/** Progress is learner-controlled; no gate and no priming requirement. */
export function updateNodeProgress(
  path: LearningPath,
  nodeId: string,
  update: ProgressUpdate,
  now: string,
): LearningPath {
  return replaceNode(
    path,
    nodeId,
    (node) => ({
      ...node,
      progression: update.progression,
      ...(update.artifactNote === undefined ? {} : { artifactNote: update.artifactNote }),
    }),
    now,
  );
}

export function newErrorEntry(input: {
  readonly id: string;
  readonly category: ErrorCategory;
  readonly summary: string;
  readonly chatId: string;
  readonly now: string;
}): ErrorEntry {
  return {
    id: input.id,
    category: input.category,
    summary: input.summary,
    resolved: false,
    createdAt: input.now,
    sessionChatId: input.chatId,
  };
}

export function appendError(
  path: LearningPath,
  nodeId: string,
  entry: ErrorEntry,
  now: string,
): LearningPath {
  return replaceNode(
    path,
    nodeId,
    (node) => ({ ...node, errors: [...node.errors, entry] }),
    now,
  );
}

export interface ErrorEntryUpdate {
  readonly resolved?: boolean;
  /** `null` clears the saved reflection; a string replaces it. */
  readonly notes?: string | null;
}

/** Resolve/unresolve one entry and edit its reflection; every other error is untouched. */
export function updateErrorEntry(
  path: LearningPath,
  nodeId: string,
  errorId: string,
  update: ErrorEntryUpdate,
  now: string,
): LearningPath {
  return replaceNode(
    path,
    nodeId,
    (node) => {
      if (!node.errors.some((entry) => entry.id === errorId)) {
        throw new DomainValidationError([
          { path: "errorId", message: `unknown error id "${errorId}" on node "${nodeId}"` },
        ]);
      }
      return {
        ...node,
        errors: node.errors.map((entry) => {
          if (entry.id !== errorId) return entry;
          const resolved = update.resolved ?? entry.resolved;
          const resolvedAt = resolved ? (entry.resolved ? entry.resolvedAt ?? now : now) : undefined;
          const notes =
            update.notes === undefined
              ? entry.notes
              : update.notes === null
                ? undefined
                : update.notes;
          return {
            id: entry.id,
            category: entry.category,
            summary: entry.summary,
            resolved,
            createdAt: entry.createdAt,
            ...(resolvedAt === undefined ? {} : { resolvedAt }),
            ...(notes === undefined ? {} : { notes }),
            ...(entry.sessionChatId === undefined
              ? {}
              : { sessionChatId: entry.sessionChatId }),
          } satisfies ErrorEntry;
        }),
      };
    },
    now,
  );
}

export function newPivotSuggestion(input: {
  readonly id: string;
  readonly proposalType: PivotProposalType;
  readonly title: string;
  readonly rationale: string;
  readonly now: string;
}): PivotSuggestion {
  return {
    id: input.id,
    status: "pending",
    proposalType: input.proposalType,
    title: input.title,
    rationale: input.rationale,
    createdAt: input.now,
  };
}

/** Advisory only: appends a pending suggestion, never inserts or reorders a node. */
export function appendPivot(
  path: LearningPath,
  nodeId: string,
  pivot: PivotSuggestion,
  now: string,
): LearningPath {
  return replaceNode(
    path,
    nodeId,
    (node) => ({ ...node, pivotSuggestions: [...node.pivotSuggestions, pivot] }),
    now,
  );
}

export type PivotAction = "accept" | "dismiss";

export interface PivotResolution {
  readonly path: LearningPath;
  readonly pivot: PivotSuggestion;
  /** The inserted repair node on accept; `null` for dismiss and repeat accepts. */
  readonly insertedNode: PathNode | null;
  readonly changed: boolean;
}

/** The learner's explicit decision on one advisory pivot.
 * Accept inserts exactly one node immediately after the current node and links it
 * back through `interleavesNodeIds`; dismiss only flips the suggestion's status.
 * Repeating the same decision is idempotent; the opposite decision is refused. */
export function resolvePivotSuggestion(
  path: LearningPath,
  nodeId: string,
  pivotId: string,
  action: PivotAction,
  now: string,
  newNodeId: string,
): PivotResolution {
  const node = findNode(path, nodeId);
  if (!node) {
    throw new DomainValidationError([{ path: "nodeId", message: `unknown node id "${nodeId}"` }]);
  }
  const pivot = node.pivotSuggestions.find((candidate) => candidate.id === pivotId);
  if (!pivot) {
    throw new DomainValidationError([
      { path: "pivotId", message: `unknown pivot id "${pivotId}" on node "${nodeId}"` },
    ]);
  }
  const targetStatus = action === "accept" ? "accepted" : "dismissed";
  if (pivot.status !== "pending") {
    if (pivot.status === targetStatus) {
      const insertedNode =
        orderedNodes(path).find((candidate) => candidate.id === pivot.insertedNodeId) ?? null;
      return { path, pivot, insertedNode, changed: false };
    }
    throw new DomainValidationError([
      {
        path: "pivotId",
        message: `pivot "${pivotId}" is already ${pivot.status}; it cannot be ${targetStatus}`,
      },
    ]);
  }

  const insertedNode: PathNode | null =
    action === "accept"
      ? {
          id: newNodeId,
          type: pivot.proposalType,
          title: pivot.title,
          goal: `Close the gap behind "${node.title}": ${pivot.rationale}`,
          sourceAnchor: node.sourceAnchor,
          interleavesNodeIds: [node.id],
          progression: "unstarted",
          childSessions: [],
          errors: [],
          pivotSuggestions: [],
        }
      : null;

  const resolvedPivot: PivotSuggestion = {
    ...pivot,
    status: targetStatus,
    resolvedAt: now,
    ...(insertedNode === null ? {} : { insertedNodeId: insertedNode.id }),
  };

  const modules = path.modules.map((module) => {
    const index = module.nodes.findIndex((candidate) => candidate.id === nodeId);
    if (index === -1) return module;
    const nodes = module.nodes.map((candidate) =>
      candidate.id === nodeId
        ? {
            ...candidate,
            pivotSuggestions: candidate.pivotSuggestions.map((candidatePivot) =>
              candidatePivot.id === pivotId ? resolvedPivot : candidatePivot,
            ),
          }
        : candidate,
    );
    if (insertedNode === null) return { ...module, nodes };
    return {
      ...module,
      nodes: [...nodes.slice(0, index + 1), insertedNode, ...nodes.slice(index + 1)],
    };
  });

  return {
    path: { ...path, updatedAt: now, modules },
    pivot: resolvedPivot,
    insertedNode,
    changed: true,
  };
}

/** A teaching chat runs the native prober and teacher; practice runs practice. */
export function kindMatchesAgent(kind: ChildSessionKind, agent: string): boolean {
  if (kind === "practice") return agent === "practice";
  return agent === "prober" || agent === "teacher";
}
