/** Learning Path — native session bridge.
 *
 * Two additive backend contributions, both scoped to native `prober`, `teacher`
 * and `practice` turns:
 * - minimal conditional instructions that are inert unless the learning_path_*
 *   tools are actually present in the turn loadout;
 * - a per-turn tool factory. It returns `[]` for every unlinked chat, so regular
 *   LearnHarness sessions are untouched. For a linked chat it exposes the node
 *   brief plus progress, error and advisory-pivot writes.
 *
 * A link is only a plugin record. The native chat remains host-owned: every
 * lookup re-reads `ctx.learning.getSession` so a deleted chat stops injecting
 * tools instead of resurrecting stale context. Pivot suggestions never mutate
 * the path; only the learner can accept one.
 */
import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  PluginAgentKind,
  PluginBackendContext,
  PluginToolContext,
  PluginTools,
} from "learnharness-plugin-api";
import {
  ERROR_CATEGORIES,
  artifactCatalogEntry,
  formatSourceAnchor,
} from "./domain.ts";
import type { ChildSessionKind, LearningPath, PathNode } from "./domain.ts";
import { buildChildSessionBrief } from "./framework.ts";
import {
  appendError,
  appendPivot,
  findChatLink,
  findNode,
  kindMatchesAgent,
  newErrorEntry,
  newPivotSuggestion,
  updateNodeProgress,
} from "./session-links.ts";
import type { LearningPathStore } from "./store.ts";
import { CHILD_PIVOT_TYPES } from "./tool-names.ts";

export const NATIVE_AGENTS: readonly PluginAgentKind[] = ["prober", "teacher", "practice"];

/** The whole instruction block is conditional on the tools being present. */
export const NATIVE_BRIDGE_INSTRUCTIONS = [
  "# Learning Path child session",
  "These tools are present only when this native session is linked to a node of the learner's Learning Path.",
  "If learning_path_get_brief is not in your current tool set, ignore this entire section and follow your normal instructions.",
  "",
  "When the tools are present:",
  "- Call learning_path_get_brief before teaching so the node goal, canonical source anchor, micro-priming hook, meso-interleaving callbacks, unresolved watchpoints and artifact configuration shape this session. Stay inside that anchor and notation.",
  "- Call learning_path_update_progress when the learner's status genuinely changes: in_progress while understanding is forming, consolidated only when they can reconstruct, apply and connect the idea. Include an artifactNote only when the artifact was actually produced.",
  "- Call learning_path_log_error for each diagnosed cognitive root cause (misconception, discrimination_error, prerequisite_gap, procedural_slip, cue_failure). Use upstreamNodeId only when the failure belongs to an interleaved earlier node.",
  "- Call learning_path_suggest_pivot only when a topic is not sticking for a specific diagnosed reason. It records an advisory pending proposal (bridge, contrast or skill) and never changes, inserts or reorders path content. The learner decides.",
  "",
  "Never invent a node id, never write progress for a different node in this session, and never restructure the path yourself.",
].join("\n");

export interface NativeBridgeOptions {
  readonly store: LearningPathStore;
  /** Backend hook for live path notifications after a tool write. */
  readonly onPathChanged?: (
    path: LearningPath,
    detail: { readonly nodeId: string; readonly chatId: string; readonly change: string },
  ) => void;
}

type JsonRecord = Record<string, unknown>;

const objectSchema = (
  properties: JsonRecord,
  required: readonly string[] = [],
): JsonRecord => ({
  type: "object",
  properties,
  required: [...required],
  additionalProperties: false,
});

const textResult = <T>(value: T, text: string): AgentToolResult<T> => ({
  content: [{ type: "text", text }],
  details: value,
});

const errorResult = (message: string): AgentToolResult<{ error: string }> => ({
  content: [{ type: "text", text: `Error: ${message}` }],
  details: { error: message },
  isError: true,
});

function readObject(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object argument.");
  }
  return value as JsonRecord;
}

function readTrimmedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const text = value.trim();
  if (text.length === 0) throw new Error(`${field} must not be blank.`);
  if (text.length > max) throw new Error(`${field} must be at most ${max} characters.`);
  return text;
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function assertLive(ctx: PluginBackendContext, signal: AbortSignal | undefined): void {
  if (ctx.signal.aborted || signal?.aborted) {
    throw new Error("The Learning Path plugin is shutting down; no change was made.");
  }
}

/** `null` means the native chat is gone; an invalid id is treated the same way. */
function nativeChatExists(ctx: PluginBackendContext, chatId: string): boolean {
  try {
    return ctx.learning.getSession(chatId) !== null;
  } catch {
    return false;
  }
}

interface LocatedChat {
  readonly path: LearningPath;
  readonly node: PathNode;
  readonly kind: ChildSessionKind;
}

/** Fresh lookup: links can be removed or chats deleted while a turn is running. */
function locateChat(store: LearningPathStore, chatId: string): LocatedChat | null {
  const located = findChatLink(store.paths(), chatId);
  if (!located) return null;
  return { path: located.path, node: located.node, kind: located.link.kind };
}

/** Deleted chats stop tools mid-turn instead of writing against a vanished session. */
function missingNativeResult(
  ctx: PluginBackendContext,
  chatId: string,
): AgentToolResult<{ error: string }> | null {
  return nativeChatExists(ctx, chatId)
    ? null
    : errorResult(`Native chat "${chatId}" no longer exists; no Learning Path change was made.`);
}

function nodeSummary(path: LearningPath, node: PathNode): JsonRecord {
  return {
    pathId: path.id,
    pathTitle: path.title,
    pathGoal: path.goal,
    nodeId: node.id,
    nodeTitle: node.title,
    nodeType: node.type,
    nodeGoal: node.goal,
    progression: node.progression,
  };
}

function briefTool(
  ctx: PluginBackendContext,
  store: LearningPathStore,
  chatId: string,
): AgentTool {
  return {
    name: "learning_path_get_brief",
    label: "Learning Path brief",
    description:
      "Read the current Learning Path node brief: node goal, canonical source anchor, loose micro-priming hook, " +
      "meso-interleaving callbacks, active error watchpoints and the generative artifact configuration. " +
      "Call this before teaching or posing practice in a linked child session.",
    parameters: objectSchema({}),
    execute: async (_toolCallId, _params, signal) => {
      assertLive(ctx, signal);
      const missing = missingNativeResult(ctx, chatId);
      if (missing) return missing;
      const located = locateChat(store, chatId);
      if (!located) {
        return errorResult("This session is no longer linked to a Learning Path node.");
      }
      const { path, node, kind } = located;
      const brief = buildChildSessionBrief({
        path,
        nodeId: node.id,
        kind,
        settings: store.settings(),
      });
      const catalog = artifactCatalogEntry(brief.artifact.type);
      const anchor = formatSourceAnchor(node.sourceAnchor);
      const details = {
        ...nodeSummary(path, node),
        kind,
        sourceAnchor: anchor,
        artifact: {
          type: brief.artifact.type,
          label: catalog.label,
          justification: catalog.justification,
          ...(brief.artifact.instructions === undefined
            ? {}
            : { instructions: brief.artifact.instructions }),
        },
        interleaved: brief.interleavedNodes.map((entry) => ({
          nodeId: entry.id,
          title: entry.title,
          type: entry.type,
        })),
        watchpoints: brief.watchpoints.map((watchpoint) => ({
          nodeId: watchpoint.nodeId,
          nodeTitle: watchpoint.nodeTitle,
          errorId: watchpoint.entry.id,
          category: watchpoint.entry.category,
          summary: watchpoint.entry.summary,
        })),
        unresolvedErrors: node.errors.filter((entry) => !entry.resolved).length,
      };
      return textResult(details, brief.text);
    },
  };
}

function progressTool(
  ctx: PluginBackendContext,
  options: NativeBridgeOptions,
  chatId: string,
): AgentTool {
  return {
    name: "learning_path_update_progress",
    label: "Update node progress",
    description:
      "Record the learner's progression on this session's node: in_progress or consolidated. " +
      "Optionally include a short artifactNote when the node's generative artifact was actually produced. " +
      "This is learner-controlled and ungated; do not mark consolidated without evidence of independent reconstruction.",
    parameters: objectSchema(
      {
        progression: {
          type: "string",
          enum: ["in_progress", "consolidated"],
          description: "The new progression state for this node.",
        },
        artifactNote: {
          type: "string",
          maxLength: 2000,
          description: "Optional short note about the produced artifact.",
        },
      },
      ["progression"],
    ),
    execute: async (_toolCallId, rawParams, signal) => {
      assertLive(ctx, signal);
      const missing = missingNativeResult(ctx, chatId);
      if (missing) return missing;
      const located = locateChat(options.store, chatId);
      if (!located) {
        return errorResult("This session is no longer linked to a Learning Path node.");
      }
      try {
        const params = readObject(rawParams);
        const progression = readEnum(
          params.progression,
          ["in_progress", "consolidated"] as const,
          "progression",
        );
        const artifactNote =
          params.artifactNote === undefined
            ? undefined
            : readTrimmedText(params.artifactNote, "artifactNote", 2000);
        const previous = located.node.progression;
        const now = new Date().toISOString();
        const next = updateNodeProgress(
          located.path,
          located.node.id,
          { progression, ...(artifactNote === undefined ? {} : { artifactNote }) },
          now,
        );
        const saved = options.store.savePath(next);
        options.onPathChanged?.(saved, {
          nodeId: located.node.id,
          chatId,
          change: "progress",
        });
        const node = findNode(saved, located.node.id);
        const details = {
          ...(node ? nodeSummary(saved, node) : nodeSummary(saved, located.node)),
          previousProgression: previous,
          ...(artifactNote === undefined ? {} : { artifactNote }),
        };
        return textResult(
          details,
          `Recorded ${progression} for "${located.node.title}" (was ${previous}).` +
            (artifactNote === undefined ? "" : " Artifact note saved."),
        );
      } catch (error) {
        if (error instanceof Error) return errorResult(error.message);
        throw error;
      }
    },
  };
}

function logErrorTool(
  ctx: PluginBackendContext,
  options: NativeBridgeOptions,
  chatId: string,
): AgentTool {
  return {
    name: "learning_path_log_error",
    label: "Log a cognitive error",
    description:
      "Record one diagnosed cognitive error in this node's Error Ledger by root-cause category. " +
      "Defaults to this session's node; pass upstreamNodeId only for an interleaved earlier node when " +
      "recall or transfer of that earlier idea failed. Entries stay unresolved until the learner resolves them.",
    parameters: objectSchema(
      {
        category: {
          type: "string",
          enum: [...ERROR_CATEGORIES],
          description: "Cognitive root cause, never a grade.",
        },
        summary: {
          type: "string",
          maxLength: 2000,
          description: "What specifically went wrong, concretely and briefly.",
        },
        upstreamNodeId: {
          type: "string",
          description: "An interleaved earlier node id when the failure belongs there.",
        },
      },
      ["category", "summary"],
    ),
    execute: async (_toolCallId, rawParams, signal) => {
      assertLive(ctx, signal);
      const missing = missingNativeResult(ctx, chatId);
      if (missing) return missing;
      const located = locateChat(options.store, chatId);
      if (!located) {
        return errorResult("This session is no longer linked to a Learning Path node.");
      }
      try {
        const params = readObject(rawParams);
        const category = readEnum(params.category, ERROR_CATEGORIES, "category");
        const summary = readTrimmedText(params.summary, "summary", 2000);
        let target = located.node;
        if (params.upstreamNodeId !== undefined) {
          const upstreamId = readTrimmedText(params.upstreamNodeId, "upstreamNodeId", 128);
          if (!located.node.interleavesNodeIds.includes(upstreamId)) {
            return errorResult(
              `"${upstreamId}" is not an interleaved earlier node of "${located.node.title}". ` +
                `Valid upstream ids: ${located.node.interleavesNodeIds.join(", ") || "none"}.`,
            );
          }
          const upstream = findNode(located.path, upstreamId);
          if (!upstream) return errorResult(`Unknown upstream node "${upstreamId}".`);
          target = upstream;
        }
        const now = new Date().toISOString();
        const entry = newErrorEntry({
          id: randomUUID(),
          category,
          summary,
          chatId,
          now,
        });
        const saved = options.store.savePath(
          appendError(located.path, target.id, entry, now),
        );
        options.onPathChanged?.(saved, {
          nodeId: target.id,
          chatId,
          change: "error",
        });
        return textResult(
          {
            ...nodeSummary(saved, target),
            errorId: entry.id,
            category: entry.category,
            summary: entry.summary,
            resolved: entry.resolved,
            sessionChatId: chatId,
          },
          `Logged a ${category} on "${target.title}": ${summary}`,
        );
      } catch (error) {
        if (error instanceof Error) return errorResult(error.message);
        throw error;
      }
    },
  };
}

function suggestPivotTool(
  ctx: PluginBackendContext,
  options: NativeBridgeOptions,
  chatId: string,
): AgentTool {
  return {
    name: "learning_path_suggest_pivot",
    label: "Suggest an advisory pivot",
    description:
      "Record an advisory pivot suggestion when a topic is not sticking for a specific diagnosed reason. " +
      "Proposal types are bridge (missing prerequisite), contrast (boundary confusion) or skill (mechanical bottleneck). " +
      "The suggestion starts pending; this tool never inserts, reorders or deletes anything. The learner decides.",
    parameters: objectSchema(
      {
        proposalType: {
          type: "string",
          enum: [...CHILD_PIVOT_TYPES],
          description: "The kind of surgical detour being suggested.",
        },
        title: { type: "string", maxLength: 300, description: "Short node-sized title." },
        rationale: {
          type: "string",
          maxLength: 2000,
          description: "Why this diagnosis calls for the proposed detour.",
        },
      },
      ["proposalType", "title", "rationale"],
    ),
    execute: async (_toolCallId, rawParams, signal) => {
      assertLive(ctx, signal);
      const missing = missingNativeResult(ctx, chatId);
      if (missing) return missing;
      const located = locateChat(options.store, chatId);
      if (!located) {
        return errorResult("This session is no longer linked to a Learning Path node.");
      }
      try {
        const params = readObject(rawParams);
        const proposalType = readEnum(params.proposalType, CHILD_PIVOT_TYPES, "proposalType");
        const title = readTrimmedText(params.title, "title", 300);
        const rationale = readTrimmedText(params.rationale, "rationale", 2000);
        const duplicate = located.node.pivotSuggestions.find(
          (pivot) =>
            pivot.status === "pending" &&
            pivot.proposalType === proposalType &&
            pivot.title === title,
        );
        if (duplicate) {
          return errorResult(`A pending ${proposalType} pivot with this title already exists.`);
        }
        const now = new Date().toISOString();
        const pivot = newPivotSuggestion({
          id: randomUUID(),
          proposalType,
          title,
          rationale,
          now,
        });
        const saved = options.store.savePath(
          appendPivot(located.path, located.node.id, pivot, now),
        );
        options.onPathChanged?.(saved, {
          nodeId: located.node.id,
          chatId,
          change: "pivot",
        });
        return textResult(
          {
            ...nodeSummary(saved, findNode(saved, located.node.id) ?? located.node),
            pivotId: pivot.id,
            proposalType: pivot.proposalType,
            title: pivot.title,
            rationale: pivot.rationale,
            status: pivot.status,
            advisory: true,
            pathMutated: false,
          },
          `Recorded an advisory ${proposalType} suggestion: "${title}". It is pending; the path was not changed. ` +
            "The learner may accept, refine or dismiss it in the Path Hub.",
        );
      } catch (error) {
        if (error instanceof Error) return errorResult(error.message);
        throw error;
      }
    },
  };
}

/** Build the tools for one frozen turn, or `[]` for an unlinked/deleted chat. */
export function createNativeTools(
  ctx: PluginBackendContext,
  options: NativeBridgeOptions,
  context: PluginToolContext,
): AgentTool[] {
  const located = locateChat(options.store, context.chatId);
  if (!located) return [];
  if (!kindMatchesAgent(located.kind, context.agent)) return [];
  if (!nativeChatExists(ctx, context.chatId)) return [];
  return [
    briefTool(ctx, options.store, context.chatId),
    progressTool(ctx, options, context.chatId),
    logErrorTool(ctx, options, context.chatId),
    suggestPivotTool(ctx, options, context.chatId),
  ];
}

/** Register instructions and per-turn tools for native agent kinds. */
export function registerNativeBridge(
  ctx: PluginBackendContext,
  options: NativeBridgeOptions,
): () => void {
  const unregisterInstructions = ctx.registerInstructions({
    agents: [...NATIVE_AGENTS],
    text: NATIVE_BRIDGE_INSTRUCTIONS,
  });
  const contribution: PluginTools = {
    agents: [...NATIVE_AGENTS],
    create: (context) => createNativeTools(ctx, options, context),
  };
  const unregisterTools = ctx.registerTools(contribution);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    unregisterInstructions();
    unregisterTools();
  };
}
