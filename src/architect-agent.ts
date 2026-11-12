/** Learning Path — the persistent Path Architect and its server-side tools.
 *
 * One plugin-owned agent definition is registered with `ctx.agents.register`.
 * Registration is reconstructed on every activation from `architect.json`, so a
 * saved conversation keeps working after a restart; unregistering cancels its
 * active runs but never deletes conversation records.
 *
 * The tools are the only way the Architect touches learner data:
 * - `list_uploaded_sources` / `read_uploaded_source_chunk` inspect converted
 *   Markdown that the frontend produced with `ctx.documents.toMarkdown`.
 * - `get_learning_path` returns the id-bearing outline needed for refinement.
 * - `save_learning_path` (or its `save_learning_path_json` fallback) is the single
 *   validated write path for a path, and it links the record to the conversation
 *   that produced it.
 */
import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
  PluginAgentDefinition,
  PluginAgentTool,
  PluginBackendContext,
  PluginModelSpec,
} from "learnharness-plugin-api";
import { ARTIFACT_TYPES, DomainValidationError, NODE_TYPES, PROGRESSION_STATES, parseLearningPath } from "./domain.ts";
import type { LearningPath, UploadedSourceReference } from "./domain.ts";
import { buildArchitectSystemPrompt } from "./framework.ts";
import { StoreError } from "./store.ts";
import type { ArchitectModelConfig, LearningPathStore } from "./store.ts";

/** Stable definition id: conversations reference it across activations. */
export const ARCHITECT_DEFINITION_ID = "path-architect";
/** Cap on one `read_uploaded_source_chunk` response, in UTF-16 code units. */
export const MAX_SOURCE_CHUNK_CHARS = 20_000;
export const DEFAULT_SOURCE_CHUNK_CHARS = 12_000;
/** A long-running design conversation needs room, but is never unbounded. */
export const ARCHITECT_MAX_TURNS = 40;

export interface ArchitectAgentOptions {
  readonly store: LearningPathStore;
  /** The most recent Architect conversation opened in this activation; the tool
   * receives no conversation identity, so the backend records it on create/send. */
  readonly activeChatId: () => string | null;
  /** Backend hook for `ctx.events.emit` after a successful tool write. */
  readonly onPathSaved?: (path: LearningPath, created: boolean) => void;
}

export interface ArchitectRegistration {
  readonly definition: PluginAgentDefinition;
  /** Unregister the definition; saved conversations remain. Idempotent. */
  readonly unregister: () => void;
}

const objectSchema = (
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> => ({
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

function readObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object argument.");
  }
  return value as Record<string, unknown>;
}

function assertLive(ctx: PluginBackendContext, signal: AbortSignal | undefined): void {
  if (ctx.signal.aborted || signal?.aborted) {
    throw new Error("The Learning Path plugin is shutting down; no change was made.");
  }
}

export function toModelSpec(model: ArchitectModelConfig): PluginModelSpec {
  return {
    provider: model.provider,
    id: model.id,
    ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel }),
  };
}

function sourceSummary(source: UploadedSourceReference): Record<string, unknown> {
  return {
    sourceId: source.sourceId,
    name: source.name,
    byteSize: source.byteSize,
    uploadedAt: source.uploadedAt,
    sha256: source.sha256,
  };
}

/** `list_uploaded_sources`: metadata only, so the conversation stays bounded. */
function listUploadedSourcesTool(
  ctx: PluginBackendContext,
  options: ArchitectAgentOptions,
): PluginAgentTool {
  return {
    name: "list_uploaded_sources",
    description:
      "List the learner's uploaded sources (Markdown converted from their PDFs or UTF-8 files). " +
      "Returns sourceId, name, byteSize and uploadedAt for each; use read_uploaded_source_chunk " +
      "to read the text. An empty list means the learner has not uploaded a corpus yet.",
    parameters: objectSchema({}),
    execute: async (_toolCallId, _params, signal) => {
      assertLive(ctx, signal);
      const sources = options.store.sources();
      return textResult(
        { sources: sources.map(sourceSummary) },
        JSON.stringify({ sources: sources.map(sourceSummary) }),
      );
    },
  };
}

/** `read_uploaded_source_chunk`: bounded character windows, never the whole book. */
function readUploadedSourceChunkTool(
  ctx: PluginBackendContext,
  options: ArchitectAgentOptions,
): PluginAgentTool {
  return {
    name: "read_uploaded_source_chunk",
    description:
      "Read one bounded chunk of an uploaded source by sourceId. Offsets count UTF-16 characters. " +
      `Returns text, chunkStart, chunkEnd, totalCharacters and nextOffset (null at the end); ` +
      `pass nextOffset as offset to continue. At most ${MAX_SOURCE_CHUNK_CHARS} characters per call.`,
    parameters: objectSchema(
      {
        sourceId: { type: "string", description: "The sourceId from list_uploaded_sources." },
        offset: {
          type: "integer",
          minimum: 0,
          description: "Character offset to start at; defaults to 0.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_SOURCE_CHUNK_CHARS,
          description: `Maximum characters to return; defaults to ${DEFAULT_SOURCE_CHUNK_CHARS}.`,
        },
      },
      ["sourceId"],
    ),
    execute: async (_toolCallId, rawParams, signal) => {
      assertLive(ctx, signal);
      try {
        const params = readObject(rawParams);
        if (typeof params.sourceId !== "string") throw new Error("sourceId must be a UUID string.");
        const offset = params.offset ?? 0;
        const limit = params.limit ?? DEFAULT_SOURCE_CHUNK_CHARS;
        if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
          throw new Error("offset must be a non-negative integer.");
        }
        if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_SOURCE_CHUNK_CHARS) {
          throw new Error(`limit must be an integer between 1 and ${MAX_SOURCE_CHUNK_CHARS}.`);
        }
        const markdown = options.store.readSource(params.sourceId);
        if (markdown === null) {
          const known = options.store
            .sources()
            .map((source) => `${source.sourceId} (${source.name})`)
            .join(", ");
          throw new Error(
            `Unknown uploaded source "${params.sourceId}". Known sources: ${known || "none"}.`,
          );
        }
        const start = Math.min(offset as number, markdown.length);
        const end = Math.min(start + (limit as number), markdown.length);
        const name =
          options.store.sources().find((source) => source.sourceId === params.sourceId)?.name ??
          `${params.sourceId}.md`;
        const result = {
          sourceId: params.sourceId,
          name,
          chunkStart: start,
          chunkEnd: end,
          totalCharacters: markdown.length,
          nextOffset: end < markdown.length ? end : null,
          text: markdown.slice(start, end),
        };
        return textResult(result, JSON.stringify(result));
      } catch (error) {
        // Bad arguments and unknown ids are model-correctable, not crashes.
        if (error instanceof Error) return errorResult(error.message);
        throw error;
      }
    },
  };
}

/** Give the model a concrete, shallow draft contract rather than asking it to
 * serialize the entire persisted LearningPath (timestamps, state and empty arrays).
 * The same tool accepts full paths for backwards-compatible refinement. */
const sourceAnchorSchema = objectSchema({
  reference: { type: "string", description: "Exact title of a source in sourceSpine." },
  chapter: { type: "string" }, section: { type: "string" }, pages: { type: "string" },
}, ["reference"]);
const SERVER_OWNED = "Server-owned learner state: ignored for existing nodes, omit for new nodes.";
const nodeDraftSchema = objectSchema({
  id: { type: "string", description: "Only for refinement: existing node id from get_learning_path. New node ids are server-generated." },
  type: { type: "string", enum: NODE_TYPES },
  title: { type: "string" }, goal: { type: "string" },
  sourceAnchor: sourceAnchorSchema,
  lightPreReading: { type: "string" },
  artifactConfig: objectSchema({
    type: { type: "string", enum: ARTIFACT_TYPES }, instructions: { type: "string" },
  }, ["type"]),
  artifactNote: { type: "string" },
  interleavesNodeIds: { type: "array", items: { type: "string" }, description: "Optional; defaults to the two preceding nodes for new nodes." },
  progression: { type: "string", enum: PROGRESSION_STATES, description: SERVER_OWNED },
  childSessions: { type: "array", items: { type: "object", additionalProperties: true }, description: SERVER_OWNED },
  errors: { type: "array", items: { type: "object", additionalProperties: true }, description: SERVER_OWNED },
  pivotSuggestions: { type: "array", items: { type: "object", additionalProperties: true }, description: SERVER_OWNED },
}, ["type", "title", "goal", "sourceAnchor"]);
const moduleDraftSchema = objectSchema({
  id: { type: "string", description: "Only for refinement: existing module id from get_learning_path." },
  title: { type: "string" }, goal: { type: "string" },
  nodes: { type: "array", minItems: 1, items: nodeDraftSchema },
}, ["title", "nodes"]);
const sourceSpineSchema = objectSchema({
  mode: { type: "string", enum: ["canonical", "uploaded"] },
  references: { type: "array", minItems: 1, items: objectSchema({
    title: { type: "string" }, kind: { type: "string", enum: ["textbook", "course", "specification"] },
    author: { type: "string" }, edition: { type: "string" },
  }, ["title", "kind"]) },
  sources: { type: "array", minItems: 1, items: objectSchema({
    sourceId: { type: "string" }, name: { type: "string" }, uploadedAt: { type: "string" },
    byteSize: { type: "integer" }, sha256: { type: "string" },
  }, ["sourceId", "name", "uploadedAt"]) },
  supplements: { type: "array", items: { type: "object", additionalProperties: true } },
}, ["mode"]);

/** A model-correctable problem with a draft; reported to the model, never thrown out of the tool. */
class DraftError extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Heal common weak-model argument shapes before schema validation: a single
 * `{ path }` wrapper, and nested `modules`/`sourceSpine` sent as JSON strings.
 * Well-formed arguments are returned unchanged (same reference). */
export function normalizeDraftArguments(args: unknown): unknown {
  if (!isRecord(args)) return args;
  let value = args;
  if (value.id === undefined && value.title === undefined && isRecord(value.path)) value = value.path;
  let healed: Record<string, unknown> | null = null;
  for (const key of ["modules", "sourceSpine"] as const) {
    const raw = value[key];
    if (typeof raw !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (key === "modules" ? Array.isArray(parsed) : isRecord(parsed)) {
        healed ??= { ...value };
        healed[key] = parsed;
      }
    } catch {
      // Unhealable: leave it for validation to reject with a precise message.
    }
  }
  return healed ?? value;
}

/** Compact, id-bearing view of a path: exactly what refinement must echo back. */
function pathOutline(path: LearningPath): Record<string, unknown> {
  return {
    id: path.id,
    title: path.title,
    goal: path.goal,
    sourceSpine: path.sourceSpine,
    ...(path.artifactDefault ? { artifactDefault: path.artifactDefault } : {}),
    modules: path.modules.map((module) => ({
      id: module.id,
      title: module.title,
      ...(module.goal === undefined ? {} : { goal: module.goal }),
      nodes: module.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        title: node.title,
        goal: node.goal,
        sourceAnchor: node.sourceAnchor,
        ...(node.lightPreReading === undefined ? {} : { lightPreReading: node.lightPreReading }),
        ...(node.artifactConfig ? { artifactConfig: node.artifactConfig } : {}),
        interleavesNodeIds: node.interleavesNodeIds,
        progression: node.progression,
      })),
    })),
  };
}

/** Complete the server-owned fields without changing existing learner state on refinement. */
function completeDraft(args: Record<string, unknown>, existing: LearningPath | null, chatId: string): Record<string, unknown> {
  const modules = args.modules;
  if (!Array.isArray(modules)) return { ...args, id: args.id ?? randomUUID(), architectChatId: chatId };
  const previousNodes = new Map(existing?.modules.flatMap(module => module.nodes.map(node => [node.id, node] as const)) ?? []);
  const previousModules = new Map(existing?.modules.map(module => [module.id, module] as const) ?? []);
  const preceding: string[] = [];
  if (existing) {
    const suppliedModules = new Set(modules.map(module => module?.id));
    const missingModules = existing.modules.map(module => module.id).filter(id => !suppliedModules.has(id));
    const suppliedNodes = new Set(modules.flatMap(module => Array.isArray(module?.nodes) ? module.nodes.map((node: { id?: unknown }) => node?.id) : []));
    const missingNodes = [...previousNodes.keys()].filter(id => !suppliedNodes.has(id));
    if (missingModules.length > 0 || missingNodes.length > 0) {
      throw new DraftError(
        "Refinement must include every existing module and node id; nothing was written. " +
          (missingModules.length > 0 ? `Missing module ids: ${missingModules.join(", ")}. ` : "") +
          (missingNodes.length > 0 ? `Missing node ids: ${missingNodes.join(", ")}. ` : "") +
          `Call get_learning_path with id "${existing.id}" for the current outline.`,
      );
    }
  }
  return {
    // Path-level preferences the draft does not mention survive refinement.
    ...(existing && existing.artifactDefault !== undefined ? { artifactDefault: existing.artifactDefault } : {}),
    ...args,
    id: args.id ?? randomUUID(),
    architectChatId: chatId,
    modules: modules.map((rawModule) => {
      if (!isRecord(rawModule)) return rawModule;
      const module = rawModule;
      const old = typeof module.id === "string" ? previousModules.get(module.id) : undefined;
      return {
        ...old, ...module, id: module.id ?? randomUUID(),
        nodes: Array.isArray(module.nodes) ? module.nodes.map((rawNode) => {
          if (!isRecord(rawNode)) return rawNode;
          const node = rawNode;
          const oldNode = typeof node.id === "string" ? previousNodes.get(node.id) : undefined;
          const id = node.id ?? randomUUID();
          // Learner state belongs to the store once a node exists: progress, child-chat
          // links, errors and pivots recorded since the model last looked must survive.
          const complete = {
            ...oldNode, ...node, id,
            progression: oldNode?.progression ?? node.progression ?? "unstarted",
            interleavesNodeIds: node.interleavesNodeIds ?? oldNode?.interleavesNodeIds ?? preceding.slice(-2),
            childSessions: oldNode?.childSessions ?? node.childSessions ?? [],
            errors: oldNode?.errors ?? node.errors ?? [],
            pivotSuggestions: oldNode?.pivotSuggestions ?? node.pivotSuggestions ?? [],
          };
          preceding.push(id as string);
          return complete;
        }) : module.nodes,
      };
    }),
  };
}

/** `get_learning_path`: the id-bearing outline the Architect needs to refine a path. */
function getLearningPathTool(
  ctx: PluginBackendContext,
  options: ArchitectAgentOptions,
): PluginAgentTool {
  return {
    name: "get_learning_path",
    description:
      "Read the current outline of a learning path, including path, module and node ids. " +
      "Call this before refining a path: save_learning_path must echo every existing module and node id. " +
      "Without id, returns the path most recently saved by this conversation, or the list of paths.",
    parameters: objectSchema({
      id: { type: "string", description: "Path id; omit for this conversation's path." },
    }),
    execute: async (_toolCallId, rawParams, signal) => {
      assertLive(ctx, signal);
      const params = isRecord(rawParams) ? rawParams : {};
      const chatId = options.activeChatId();
      let path: LearningPath | null = null;
      if (typeof params.id === "string") {
        path = options.store.path(params.id);
      } else if (chatId) {
        path = options.store
          .paths()
          .filter((candidate) => candidate.architectChatId === chatId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
      }
      if (!path) {
        const known = options.store.paths().map((candidate) => ({ id: candidate.id, title: candidate.title }));
        if (typeof params.id === "string") {
          return errorResult(`Unknown learning path "${params.id}". Known paths: ${JSON.stringify(known)}`);
        }
        return textResult({ paths: known }, JSON.stringify({ paths: known }));
      }
      const outline = pathOutline(path);
      return textResult({ path: outline }, JSON.stringify(outline));
    },
  };
}

/** `save_learning_path`: validate, link to the conversation, persist atomically. */
function saveLearningPathTool(
  ctx: PluginBackendContext,
  options: ArchitectAgentOptions,
  jsonInput = false,
): PluginAgentTool {
  return {
    name: jsonInput ? "save_learning_path_json" : "save_learning_path",
    description: jsonInput
      ? "Fallback if the structured tool cannot transmit nested arrays. Pass ONE valid JSON object as " +
        "the draftJson string (not XML/DSML tags or prose). The server parses and validates it, " +
        "adds ids, timestamps and node state, then saves atomically."
      : "Save a path draft. Supply title, goal, sourceSpine and modules with semantic node " +
        "fields (type, title, goal, sourceAnchor OBJECT). The server adds ids, timestamps, " +
        "unstarted progression, empty state arrays and interleaving with preceding nodes. " +
        "For refinement call get_learning_path first and include the existing path, module and node ids; " +
        "learner state on existing nodes is always preserved. " +
        "Do not emit XML tags, a JSON string or prose. Invalid drafts are rejected without writing.",
    parameters: jsonInput ? objectSchema({
      draftJson: { type: "string", description: "JSON object with title, goal, sourceSpine and modules; no markup or code fences." },
    }, ["draftJson"]) : objectSchema({
      id: { type: "string", description: "Only for refinement: the existing path id." },
      title: { type: "string" }, goal: { type: "string" },
      sourceSpine: sourceSpineSchema,
      modules: { type: "array", minItems: 1, items: moduleDraftSchema },
      createdAt: { type: "string", description: "Optional legacy field; the server supplies this for new drafts." },
      updatedAt: { type: "string", description: "Optional legacy field; the server always updates this." },
      architectChatId: { type: "string", description: "Optional legacy field; the server links the active conversation." },
      artifactDefault: { type: "string", enum: ARTIFACT_TYPES },
    }, ["title", "goal", "sourceSpine", "modules"]),
    // Runs before schema validation, so string-encoded nested values are healed
    // instead of failing validation before `execute` can explain anything.
    ...(jsonInput ? {} : { prepareArguments: (args: unknown) => normalizeDraftArguments(args) as never }),
    execute: async (_toolCallId, rawParams, signal) => {
      assertLive(ctx, signal);
      const chatId = options.activeChatId();
      if (!chatId) {
        return errorResult(
          "No active Architect conversation. Open or create an Architect conversation before saving a path.",
        );
      }
      let parsed: LearningPath;
      try {
        let args = readObject(rawParams);
        if (jsonInput) {
          if (typeof args.draftJson !== "string" || args.draftJson.length > 200_000) {
            return errorResult("draftJson must be a JSON string of at most 200000 characters.");
          }
          try {
            args = readObject(JSON.parse(args.draftJson));
          } catch {
            return errorResult("draftJson must contain one valid JSON object (no code fences or tool-call tags).");
          }
        }
        // The same healing as prepareArguments: a `{ path }` wrapper or string-encoded nesting.
        args = readObject(normalizeDraftArguments(args));
        const existing = typeof args.id === "string" ? options.store.path(args.id) : null;
        const candidate = completeDraft(args, existing, chatId);
        const now = new Date().toISOString();
        // The store, not the model, owns identity and modification time.
        candidate.createdAt = existing?.createdAt ?? candidate.createdAt ?? now;
        candidate.updatedAt = now;
        candidate.architectChatId = chatId;
        parsed = parseLearningPath(candidate);
        for (const source of uploadedSources(parsed)) {
          if (options.store.readSource(source.sourceId) === null) {
            return errorResult(
              `Source spine references uploaded source "${source.sourceId}" (${source.name}), which is not stored. ` +
                "Call list_uploaded_sources and use a real sourceId.",
            );
          }
        }
        assertLive(ctx, signal);
      } catch (error) {
        if (error instanceof DomainValidationError) {
          const issues = error.issues
            .slice(0, 12)
            .map((issue) => `${issue.path}: ${issue.message}`)
            .join("; ");
          return errorResult(`Learning path rejected; nothing was written. ${issues}`);
        }
        if (error instanceof StoreError) return errorResult(error.message);
        if (error instanceof DraftError) return errorResult(error.message);
        throw error;
      }

      const created = options.store.path(parsed.id) === null;
      const saved = options.store.savePath(parsed);
      options.onPathSaved?.(saved, created);
      const nodes = saved.modules.reduce((total, module) => total + module.nodes.length, 0);
      return textResult(
        {
          pathId: saved.id,
          title: saved.title,
          created,
          modules: saved.modules.length,
          nodes,
          updatedAt: saved.updatedAt,
        },
        // The outline carries the server-generated ids the Architect needs to refine later.
        `${created ? "Created" : "Updated"} learning path "${saved.title}" (${saved.id}) with ` +
          `${saved.modules.length} module(s) and ${nodes} node(s). Outline with ids: ` +
          JSON.stringify({
            id: saved.id,
            modules: saved.modules.map((module) => ({
              id: module.id,
              title: module.title,
              nodes: module.nodes.map((node) => ({ id: node.id, title: node.title })),
            })),
          }),
      );
    },
  };
}

function uploadedSources(path: LearningPath): readonly UploadedSourceReference[] {
  if (path.sourceSpine.mode === "uploaded") return path.sourceSpine.sources;
  return path.sourceSpine.supplements ?? [];
}

/** Build the definition the host registers; exposed for lifecycle assertions. */
export function buildArchitectDefinition(
  ctx: PluginBackendContext,
  model: ArchitectModelConfig,
  options: ArchitectAgentOptions,
): PluginAgentDefinition {
  return {
    id: ARCHITECT_DEFINITION_ID,
    model: toModelSpec(model),
    instructions: buildArchitectSystemPrompt({ settings: options.store.settings() }),
    maxTurns: ARCHITECT_MAX_TURNS,
    tools: [
      listUploadedSourcesTool(ctx, options),
      readUploadedSourceChunkTool(ctx, options),
      getLearningPathTool(ctx, options),
      saveLearningPathTool(ctx, options),
      saveLearningPathTool(ctx, options, true),
    ],
  };
}

/** Register the Path Architect for one activation. Throws on an invalid definition. */
export function registerArchitect(
  ctx: PluginBackendContext,
  model: ArchitectModelConfig,
  options: ArchitectAgentOptions,
): ArchitectRegistration {
  const definition = buildArchitectDefinition(ctx, model, options);
  const unregister = ctx.agents.register(definition);
  return { definition, unregister };
}
