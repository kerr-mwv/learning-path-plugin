/** Learning Path — backend activation.
 *
 * Wires these things over one plugin-owned store:
 * - the persistent Path Architect definition, registered from `architect.json`
 *   on activation and re-registered when the learner chooses another model;
 * - `ctx.handle` operations for paths, uploaded sources, Architect conversations
 *   (create/send/abort), child-session links (prepare/link/unlink/status),
 *   Error Ledger entries, advisory pivots, settings and safe path deletion, with
 *   request IDs delegated to the host so a retried send is accepted once;
 * - the native bridge: conditional instructions plus per-turn learning_path_*
 *   tools for linked prober/teacher/practice turns, and `[]` otherwise;
 * - `ctx.events.emit` notifications after every observable write, so any open
 *   window can refetch instead of polling.
 *
 * Everything is scoped to the activation: the abort handler cancels Architect
 * runs, `cleanup` releases handlers, subscriptions, the bridge and the definition,
 * and no tool writes after the signal aborts.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { ChatPathPreview } from "./session-types.ts";
import { CHAT_PATH_ARCHITECT_ID, reviewableChatPath } from "./chat-to-path.ts";
import type {
  ModelCatalogResponse,
  PluginAgentDefinition,
  PluginAgentSnapshot,
  PluginBackendContext,
} from "learnharness-plugin-api";
import {
  ARCHITECT_DEFINITION_ID,
  approveChatPathProposal,
  buildArchitectDefinition,
  registerArchitect,
} from "./architect-agent.ts";
import type { ArchitectRegistration } from "./architect-agent.ts";
import {
  ARTIFACT_TYPES,
  CHILD_SESSION_KINDS,
  DomainValidationError,
  PROGRESSION_STATES,
  MAX_PATH_TAGS,
  MAX_WORKSPACE_ITEM_TITLE_LENGTH,
  MAX_WORKSPACE_NOTE_BYTES,
  WORKSPACE_LINK_RELS,
  parsePathFolder,
  parsePathTag,
  parsePluginSettings,
} from "./domain.ts";
import type {
  ArchitectPreferences,
  ArtifactConfig,
  ChildSessionKind,
  LearningPath,
  PathNode,
  PluginSettings,
  WorkspaceLinkRel,
  WorkspaceItem,
} from "./domain.ts";
import { buildChildSessionBrief } from "./framework.ts";
import { exportLearningPath } from "./export.ts";
import { registerNativeBridge } from "./native-bridge.ts";
import {
  addChildLink,
  findChatLink,
  removeChildLink,
  resolvePivotSuggestion,
  updateErrorEntry,
} from "./session-links.ts";
import type { PivotAction } from "./session-links.ts";
import {
  MAX_SOURCE_BYTES,
  THINKING_LEVELS,
  openLearningPathStore,
} from "./store.ts";
import type {
  ArchitectModelConfig,
  LearningPathStore,
  ThinkingLevelName,
} from "./store.ts";
import {
  EVENT_ARCHITECT_CHANGED,
  EVENT_PATHS_CHANGED,
  EVENT_SETTINGS_CHANGED,
  EVENT_SOURCES_CHANGED,
  EVENT_WORKSPACE_CHANGED,
} from "./topics.ts";
import type { ArchitectProgress } from "./topics.ts";

/** Live notification topics; consumers refetch authoritative state on receipt. */
export {
  EVENT_ARCHITECT_CHANGED,
  EVENT_PATHS_CHANGED,
  EVENT_SETTINGS_CHANGED,
  EVENT_SOURCES_CHANGED,
  EVENT_WORKSPACE_CHANGED,
};

const MAX_REQUEST_ID = 200;
const MAX_MESSAGE_CHARS = 100_000;
/** Bounded in-memory dedupe for a retried create within one activation. */
const MAX_CREATE_REQUESTS = 50;

interface PathSummary {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly updatedAt: string;
  readonly moduleCount: number;
  readonly nodeCount: number;
  readonly sourceMode: LearningPath["sourceSpine"]["mode"];
  /** Spine titles for the overview card; canonical references or uploads. */
  readonly sourceTitles: readonly string[];
  /** Ungated node-state inventory: honest counts, never a completion target. */
  readonly nodeStates: Readonly<Record<PathNode["progression"], number>>;
  readonly pendingPivotCount: number;
  readonly unresolvedErrorCount: number;
  /** Learner-owned grouping tags; absent on old paths reads as none. */
  readonly tags: readonly string[];
  /** The path's one folder home, or null when unfiled. */
  readonly folder: string | null;
  readonly architectChatId?: string | null;
}

function object(value: unknown, operation: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${operation} expects an object input.`);
  }
  return value as Record<string, unknown>;
}

function readText(
  value: unknown,
  field: string,
  { max = 300, trim = false }: { max?: number; trim?: boolean } = {},
): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const text = trim ? value.trim() : value;
  if (text.length === 0) throw new Error(`${field} must not be blank.`);
  if (text.length > max) throw new Error(`${field} must be at most ${max} characters.`);
  return text;
}

function readRequestId(value: unknown): string {
  const requestId = readText(value, "requestId", { max: MAX_REQUEST_ID });
  if (requestId !== requestId.trim()) throw new Error("requestId must not have surrounding whitespace.");
  if (/[\u0000-\u001f\u007f]/.test(requestId)) throw new Error("requestId must not contain control characters.");
  return requestId;
}

function readArchitectModel(value: unknown): ArchitectModelConfig {
  const record = object(value, "model");
  const provider = readText(record.provider, "model.provider", { max: 200 });
  const id = readText(record.id, "model.id", { max: 200 });
  const level = record.thinkingLevel;
  if (level === undefined) return { provider, id };
  if (typeof level !== "string" || !(THINKING_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`model.thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}.`);
  }
  return { provider, id, thinkingLevel: level as ThinkingLevelName };
}

function readKind(value: unknown): ChildSessionKind {
  if (typeof value !== "string" || !(CHILD_SESSION_KINDS as readonly string[]).includes(value)) {
    throw new Error(`kind must be one of: ${CHILD_SESSION_KINDS.join(", ")}.`);
  }
  return value as ChildSessionKind;
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field} must be a boolean.`);
  return value;
}

function readPivotAction(value: unknown): PivotAction {
  if (value !== "accept" && value !== "dismiss") {
    throw new Error('action must be "accept" or "dismiss".');
  }
  return value;
}

function readLinkRel(value: unknown): WorkspaceLinkRel {
  if (typeof value !== "string" || !(WORKSPACE_LINK_RELS as readonly string[]).includes(value)) {
    throw new Error(`rel must be one of: ${WORKSPACE_LINK_RELS.join(", ")}.`);
  }
  return value as WorkspaceLinkRel;
}

/** Learner grouping tags, validated with the domain's own rules so the store
 * and the RPC surface cannot disagree. Empty means "no tags" (the key is
 * dropped from the record), matching absent-on-old-paths. */
function readTagsInput(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error("tags must be an array.");
  if (value.length > MAX_PATH_TAGS) {
    throw new Error(`tags accepts at most ${MAX_PATH_TAGS} entries.`);
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    let tag: string;
    try {
      tag = parsePathTag(entry, `tags[${index}]`);
    } catch (error) {
      if (error instanceof DomainValidationError) {
        throw new Error(error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
      }
      throw error;
    }
    if (seen.has(tag.toLowerCase())) {
      throw new Error(`tags[${index}]: duplicate tag "${tag}".`);
    }
    seen.add(tag.toLowerCase());
    return tag;
  });
}

/** Learner folder input. `undefined` leaves the current folder alone; `null`
 * or an empty string clears it, mirroring how empty tags drop the key. */
function readFolderInput(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("folder must be a string or null.");
  if (value.trim().length === 0) return null;
  try {
    return parsePathFolder(value, "folder");
  } catch (error) {
    if (error instanceof DomainValidationError) {
      throw new Error(error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    }
    throw error;
  }
}

/** Uploaded source ids a path references, so deletion can remove only orphans. */
function sourceIdsForPath(path: LearningPath): readonly string[] {
  const ids = new Set<string>();
  if (path.sourceSpine.mode === "uploaded") {
    for (const source of path.sourceSpine.sources) ids.add(source.sourceId);
  } else {
    for (const source of path.sourceSpine.supplements ?? []) ids.add(source.sourceId);
  }
  return [...ids];
}

function preferenceModel(preferences: ArchitectPreferences | undefined): ArchitectModelConfig | null {
  if (!preferences || preferences.followHostSlot || !preferences.model) return null;
  return {
    provider: preferences.model.provider,
    id: preferences.model.id,
    ...(preferences.thinkingLevel === undefined
      ? {}
      : { thinkingLevel: preferences.thinkingLevel }),
  };
}

function findNodeById(path: LearningPath, nodeId: string): PathNode | null {
  return path.modules.flatMap((module) => module.nodes).find((node) => node.id === nodeId) ?? null;
}

function summarize(path: LearningPath): PathSummary {
  const nodes = path.modules.flatMap((module) => module.nodes);
  const nodeStates: Record<PathNode["progression"], number> = {
    unstarted: 0,
    in_progress: 0,
    consolidated: 0,
  };
  let pendingPivotCount = 0;
  let unresolvedErrorCount = 0;
  for (const node of nodes) {
    nodeStates[node.progression] += 1;
    pendingPivotCount += node.pivotSuggestions.filter((pivot) => pivot.status === "pending").length;
    unresolvedErrorCount += node.errors.filter((error) => !error.resolved).length;
  }
  const spine = path.sourceSpine;
  const sourceTitles =
    spine.mode === "canonical"
      ? spine.references.map((reference) => reference.title)
      : spine.sources.map((source) => source.name);
  return {
    id: path.id,
    title: path.title,
    goal: path.goal,
    updatedAt: path.updatedAt,
    moduleCount: path.modules.length,
    nodeCount: nodes.length,
    sourceMode: spine.mode,
    sourceTitles,
    nodeStates,
    pendingPivotCount,
    unresolvedErrorCount,
    tags: path.tags ?? [],
    folder: path.folder ?? null,
    architectChatId: path.architectChatId ?? null,
  };
}

function sameModel(a: ArchitectModelConfig, b: ArchitectModelConfig): boolean {
  return a.provider === b.provider && a.id === b.id && a.thinkingLevel === b.thinkingLevel;
}

/** Native chat kinds are `teach`/`practice`; plugin links say `teaching`/`practice`. */
function nativeKind(record: { readonly kind?: "teach" | "practice" }): ChildSessionKind {
  return record.kind === "practice" ? "practice" : "teaching";
}

/** A deleted native chat reads as `null`; invalid ids are treated as missing. */
function nativeSession(ctx: PluginBackendContext, chatId: string) {
  try {
    return ctx.learning.getSession(chatId);
  } catch {
    return null;
  }
}

/** One inspector edit: progression and/or the per-node artifact override.
 * Everything else in the path (identity, ordering, createdAt) is preserved. */
function updateNodeInPath(
  path: LearningPath,
  nodeId: string,
  progression: PathNode["progression"] | undefined,
  artifactConfig: ArtifactConfig | null | undefined,
): LearningPath {
  let found = false;
  const modules = path.modules.map((module) => ({
    ...module,
    nodes: module.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      found = true;
      return {
        ...node,
        ...(progression === undefined ? {} : { progression }),
        ...(artifactConfig === undefined ? {} : { artifactConfig }),
      } satisfies PathNode;
    }),
  }));
  if (!found) throw new Error(`Unknown node: ${nodeId}`);
  return {
    ...path,
    updatedAt: new Date().toISOString(),
    modules,
  };
}

/** The OS file-manager command per platform; every other platform falls back
 * to the freedesktop opener. Exported for documentation and tests. */
const PLATFORM_FILE_MANAGERS: Readonly<Partial<Record<NodeJS.Platform, string>>> = {
  darwin: "open",
  win32: "explorer",
};
const FALLBACK_FILE_MANAGER = "xdg-open";

/** Reveal one directory in the host OS's file manager. The child is detached
 * and unref'd so the backend never waits on a GUI window; a missing opener
 * rejects so the frontend can surface the failure. */
export async function revealInFileManager(directory: string): Promise<void> {
  const command = PLATFORM_FILE_MANAGERS[process.platform] ?? FALLBACK_FILE_MANAGER;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [directory], { detached: true, stdio: "ignore" });
    child.once("error", (problem) => {
      reject(
        new Error(
          `Could not open the file manager (${command}): ${
            problem instanceof Error ? problem.message : String(problem)
          }`,
        ),
      );
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** The OS opener per platform for handing one file to the learner's chosen
 * application. Windows shows its native "How do you want to open this file?"
 * chooser (OpenAs_RunDLL) so the learner always picks the application; macOS
 * and the freedesktop fallback open the registered default and the OS itself
 * prompts for an application wherever none is registered. Exported for
 * documentation and tests. */
const PLATFORM_OPENERS: Readonly<
  Partial<Record<NodeJS.Platform, { readonly command: string; readonly args: readonly string[] }>>
> = {
  darwin: { command: "open", args: [] },
  win32: { command: "rundll32", args: ["shell32.dll,OpenAs_RunDLL"] },
};
const FALLBACK_OPENER = { command: "xdg-open", args: [] } as const;

/** Hand one file to the OS, which opens it in an application of the learner's
 * choosing (prompting for one where no default is registered). The child is
 * detached and unref'd so the backend never waits on a GUI window; a missing
 * opener rejects so the frontend can surface the failure. */
export async function openWithApplicationChooser(file: string): Promise<void> {
  const opener = PLATFORM_OPENERS[process.platform] ?? FALLBACK_OPENER;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opener.command, [...opener.args, file], { detached: true, stdio: "ignore" });
    child.once("error", (problem) => {
      reject(
        new Error(
          `Could not open the file in an editor (${opener.command}): ${
            problem instanceof Error ? problem.message : String(problem)
          }`,
        ),
      );
    });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

/** Optional activation seams, so tests never spawn a real GUI process. */
export interface BackendActivationOptions {
  /** Replace the OS file-manager opener behind workspace.openDirectory. */
  readonly openInFileManager?: (directory: string) => Promise<void>;
  /** Replace the OS application opener behind workspace.openItem. */
  readonly openWithApplicationChooser?: (file: string) => Promise<void>;
}

export function activate(ctx: PluginBackendContext, options: BackendActivationOptions = {}): void {
  const openInFileManager = options.openInFileManager ?? revealInFileManager;
  const openInApplication = options.openWithApplicationChooser ?? openWithApplicationChooser;
  const store: LearningPathStore = openLearningPathStore(ctx.dataDirectory);
  const disposers: (() => void)[] = [];
  const watchers = new Map<string, () => void>();
  const notificationKeys = new Map<string, string>();
  const progressTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Latest snapshot per watched conversation, so progress reads need no history copy.
  const latestSnapshots = new Map<string, PluginAgentSnapshot>();
  // Opt-in, metadata-only diagnostics; never log prompts, source text or reasoning.
  const debug = (event: string, detail: Record<string, unknown>): void => {
    if (process.env.LEARNING_PATH_DEBUG === "1") console.debug("[learning-path]", event, detail);
  };
  const createRequests = new Map<string, string>();
  let architect: ArchitectRegistration | null = null;
  let unregisterChatArchitect: (() => void) | null = null;
  // A settings model change saved while an Architect conversation was running;
  // applied once no Architect conversation is running.
  let pendingModel: ArchitectModelConfig | null = null;
  let activeChatId: string | null = null;
  let disposed = false;

  const emit = (topic: string, data: unknown): void => {
    if (ctx.signal.aborted || disposed) return;
    ctx.events.emit(topic, data);
  };

  const cleanup = (): void => {
    if (disposed) return;
    disposed = true;
    for (const timer of progressTimers.values()) clearTimeout(timer);
    progressTimers.clear();
    for (const unsubscribe of watchers.values()) unsubscribe();
    watchers.clear();
    latestSnapshots.clear();
    architect?.unregister();
    architect = null;
    unregisterChatArchitect?.();
    unregisterChatArchitect = null;
    for (const dispose of disposers.reverse()) dispose();
  };
  ctx.cleanup(cleanup);

  // Native child-session tools and conditional instructions. Registered for
  // prober/teacher/practice; the per-turn factory returns [] for unlinked chats.
  const nativeBridge = registerNativeBridge(ctx, {
    store,
    onPathChanged: (path, detail) =>
      emit(EVENT_PATHS_CHANGED, { id: path.id, ...detail, updatedAt: path.updatedAt }),
  });
  disposers.push(nativeBridge.dispose);

  const cancelRuns = (): void => {
    const ids = new Set(watchers.keys());
    if (activeChatId) ids.add(activeChatId);
    for (const id of ids) {
      try {
        ctx.agents.abort(id);
      } catch {
        // Unknown/removed conversations cannot run; nothing to cancel.
      }
    }
  };
  ctx.signal.addEventListener("abort", cancelRuns, { once: true });
  ctx.cleanup(() => ctx.signal.removeEventListener("abort", cancelRuns));

  const releaseChatArchitect = (): void => {
    unregisterChatArchitect?.();
    unregisterChatArchitect = null;
  };

  const registerChatArchitect = (model: ArchitectModelConfig): void => {
    unregisterChatArchitect ??= ctx.agents.register(buildArchitectDefinition(ctx, model, {
      store, activeChatId: () => null,
    }, true));
  };

  const registerModel = (model: ArchitectModelConfig): void => {
    pendingModel = null;
    architect?.unregister();
    architect = null;
    releaseChatArchitect();
    const registration = registerArchitect(ctx, model, {
      store,
      activeChatId: () => activeChatId,
      onPathSaved: (path, created) =>
        emit(EVENT_PATHS_CHANGED, { id: path.id, created, updatedAt: path.updatedAt }),
    });
    try {
      if (ctx.agents.list().some((chat) => chat.definitionId === CHAT_PATH_ARCHITECT_ID)) registerChatArchitect(model);
      const saved = store.architectModel();
      if (!saved || !sameModel(saved, model)) store.saveArchitectModel(model);
    } catch (error) {
      registration.unregister();
      releaseChatArchitect();
      throw error;
    }
    architect = registration;
  };

  // The host binds a model to the definition, not to a conversation, so every
  // Architect conversation shares one model. Re-registering cancels active runs,
  // so a model switch is refused while any Architect conversation is running.
  const runningArchitectConversation = (): string | null => {
    try {
      return (
        ctx.agents
          .list()
          .find((record) => (record.definitionId === ARCHITECT_DEFINITION_ID || record.definitionId === CHAT_PATH_ARCHITECT_ID) && record.status === "running")
          ?.id ?? null
      );
    } catch {
      return null;
    }
  };

  const ensureRegistered = (model: ArchitectModelConfig): void => {
    if (architect && sameModel(architect.definition.model, model)) return;
    if (architect && runningArchitectConversation()) {
      throw new Error(
        "An Architect conversation is still running. Stop it or wait for it to finish before " +
          "switching the Architect model; all Architect conversations share one model.",
      );
    }
    registerModel(model);
  };

  // Settings never cancel a run: a model change waits until no Architect
  // conversation is running. Returns whether the change was deferred.
  const applySettingsModel = (model: ArchitectModelConfig): boolean => {
    if (architect && sameModel(architect.definition.model, model)) {
      pendingModel = null;
      return false;
    }
    if (architect && runningArchitectConversation()) {
      pendingModel = model;
      debug("architect.model.deferred", { provider: model.provider, id: model.id });
      return true;
    }
    registerModel(model);
    return false;
  };

  const applyPendingModel = (): void => {
    if (!pendingModel || disposed || ctx.signal.aborted || runningArchitectConversation()) return;
    const model = pendingModel;
    try {
      registerModel(model);
      debug("architect.model.applied", { provider: model.provider, id: model.id });
    } catch (error) {
      // Keep the current registration; the next create re-resolves the preference.
      pendingModel = null;
      debug("architect.model.failed", { message: error instanceof Error ? error.message : String(error) });
    }
  };

  const watch = (id: string): void => {
    if (watchers.has(id)) return;
    const onChange = (snapshot: PluginAgentSnapshot): void => {
      latestSnapshots.set(id, snapshot);
      // Transition updates are immediate; stream updates are sampled so the view
      // can fetch evolving reasoning/text without a request per token. The view
      // reads those ticks through architect.progress, which omits the history.
      const key = `${snapshot.status}:${snapshot.messages.length}:${snapshot.partial ? "1" : "0"}`;
      const changed = notificationKeys.get(id) !== key;
      notificationKeys.set(id, key);
      const notify = () => {
        progressTimers.delete(id);
        emit(EVENT_ARCHITECT_CHANGED, {
          id: snapshot.id, kind: "state", status: snapshot.status,
          messageCount: snapshot.messages.length, partial: Boolean(snapshot.partial),
          updatedAt: snapshot.updatedAt,
        });
      };
      if (changed) {
        const timer = progressTimers.get(id);
        if (timer) clearTimeout(timer);
        notify();
        if (snapshot.status !== "running") applyPendingModel();
        debug("architect.state", { id, status: snapshot.status, messages: snapshot.messages.length, partial: Boolean(snapshot.partial) });
      } else if (snapshot.partial && !progressTimers.has(id)) {
        progressTimers.set(id, setTimeout(notify, 300));
      }
    };
    watchers.set(id, ctx.agents.subscribe(id, onChange));
  };

  const assertModelAvailable = (catalog: ModelCatalogResponse, choice: ArchitectModelConfig): void => {
    const entry = catalog.models.find(
      (candidate) => candidate.provider === choice.provider && candidate.id === choice.id,
    );
    if (!entry) {
      throw new Error(
        `Model ${choice.provider}:${choice.id} is not available in your configured connections.`,
      );
    }
    if (choice.thinkingLevel && !entry.supportedLevels.includes(choice.thinkingLevel)) {
      throw new Error(
        `Model ${choice.provider}:${choice.id} does not support thinking level ${choice.thinkingLevel}.`,
      );
    }
  };

  const resolveModel = async (input: unknown): Promise<ArchitectModelConfig> => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const catalog: ModelCatalogResponse = await ctx.inference.catalog();
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");

    const preferences = store.settings().architect;
    let choice: ArchitectModelConfig;
    if (input !== undefined && input !== null) {
      choice = readArchitectModel(input);
    } else if (preferences && !preferences.followHostSlot && preferences.model) {
      // An explicit plugin override wins over a model saved by an older activation.
      choice = preferenceModel(preferences) as ArchitectModelConfig;
    } else if (preferences?.followHostSlot || preferences === undefined) {
      const slot = catalog.slots.strong;
      if (slot) {
        choice = {
          provider: slot.model.provider,
          id: slot.model.id,
          ...(slot.thinkingLevel === undefined ? {} : { thinkingLevel: slot.thinkingLevel }),
        };
      } else if (catalog.defaults) {
        choice = {
          provider: catalog.defaults.model.provider,
          id: catalog.defaults.model.id,
          ...(catalog.defaults.thinkingLevel === undefined
            ? {}
            : { thinkingLevel: catalog.defaults.thinkingLevel }),
        };
      } else {
        const saved = store.architectModel();
        if (!saved) {
          throw new Error(
            "No Architect model is configured. Choose a model from your configured connections.",
          );
        }
        choice = saved;
      }
    } else {
      const saved = store.architectModel();
      if (!saved) {
        throw new Error(
          "No Architect model is configured. Choose a model from your configured connections.",
        );
      }
      choice = saved;
    }

    assertModelAvailable(catalog, choice);
    return choice;
  };

  const handle = (name: string, handler: (input: unknown) => unknown | Promise<unknown>): void => {
    disposers.push(ctx.handle(name, handler));
  };

  handle("paths.status", () => ({
    id: ctx.manifest.id,
    version: ctx.manifest.version,
    active: !ctx.signal.aborted,
  }));

  handle("paths.list", () => ({ paths: store.paths().map(summarize) }));

  handle("paths.get", (input) => {
    const id = readText(object(input, "paths.get").id, "id", { max: 128 });
    return { path: store.path(id) };
  });

  handle("paths.export", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "paths.export");
    const rawId = value.pathId ?? value.id;
    const pathId = readText(rawId, "pathId", { max: 128 });
    if (value.format !== "json" && value.format !== "markdown") {
      throw new Error('format must be "json" or "markdown".');
    }
    const path = store.path(pathId);
    if (!path) throw new Error(`Unknown path: ${pathId}`);
    // The Workspace rides along on Markdown exports; notes are carried verbatim.
    const workspace = store.workspace(pathId);
    const workspaceItems = (workspace?.items ?? []).map((item) => ({
      item,
      content: store.readWorkspaceItemContent(pathId, item.id),
    }));
    return exportLearningPath(path, value.format, store.settings(), workspaceItems);
  });

  // ---- Settings -----------------------------------------------------------

  handle("settings.get", () => ({ settings: store.settings() }));

  handle("settings.save", async (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    // Validate the whole record before anything is written.
    const requested = parsePluginSettings(input);
    const preference = preferenceModel(requested.architect);
    if (preference) {
      const catalog = await ctx.inference.catalog();
      if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
      assertModelAvailable(catalog, preference);
    }
    const saved = store.saveSettings(requested);
    nativeBridge.refreshGraphInstructions();
    const override = preferenceModel(saved.architect);
    if (override) {
      const modelPending = applySettingsModel(override);
      emit(EVENT_SETTINGS_CHANGED, { settings: saved, modelPending });
      return { settings: saved, modelPending };
    }
    // Following the host slot: the next conversation re-resolves the model.
    pendingModel = null;
    emit(EVENT_SETTINGS_CHANGED, { settings: saved, modelPending: false });
    return { settings: saved, modelPending: false };
  });

  // Manual inspector edits. The Architect remains the only author of new paths;
  // this narrow write lets the learner record progression and an artifact choice.
  handle("paths.updateNode", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "paths.updateNode");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    const nodeId = readText(value.nodeId, "nodeId", { max: 128 });
    const hasProgression = value.progression !== undefined;
    const hasArtifact = Object.prototype.hasOwnProperty.call(value, "artifactType");
    if (!hasProgression && !hasArtifact) {
      throw new Error("paths.updateNode needs progression or artifactType.");
    }

    let progression: PathNode["progression"] | undefined;
    if (hasProgression) {
      if (
        typeof value.progression !== "string" ||
        !(PROGRESSION_STATES as readonly string[]).includes(value.progression)
      ) {
        throw new Error(`progression must be one of: ${PROGRESSION_STATES.join(", ")}.`);
      }
      progression = value.progression as PathNode["progression"];
    }

    const path = store.path(pathId);
    if (!path) throw new Error(`Unknown path: ${pathId}`);

    let artifactConfig: ArtifactConfig | null | undefined;
    if (hasArtifact) {
      if (value.artifactType === null) {
        artifactConfig = null;
      } else {
        if (
          typeof value.artifactType !== "string" ||
          !(ARTIFACT_TYPES as readonly string[]).includes(value.artifactType)
        ) {
          throw new Error(
            `artifactType must be null or one of: ${ARTIFACT_TYPES.join(", ")}.`,
          );
        }
        const existing = path.modules
          .flatMap((module) => module.nodes)
          .find((node) => node.id === nodeId);
        artifactConfig =
          existing?.artifactConfig?.type === value.artifactType
            ? existing.artifactConfig
            : { type: value.artifactType as ArtifactConfig["type"] };
      }
    }

    const saved = store.savePath(updateNodeInPath(path, nodeId, progression, artifactConfig));
    emit(EVENT_PATHS_CHANGED, {
      id: saved.id,
      nodeId,
      updatedAt: saved.updatedAt,
    });
    return { path: saved };
  });

  // ---- Learner grouping metadata ------------------------------------------

  // Tags are learner-owned filing (an exam, a field, a project). The Architect
  // has no tool that writes them, and grouping stays topical, never temporal.
  handle("paths.updateMeta", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "paths.updateMeta");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    const tags = readTagsInput(value.tags);
    const folder = readFolderInput(value.folder);
    const path = store.path(pathId);
    if (!path) throw new Error(`Unknown path: ${pathId}`);
    const nextFolder = folder === undefined ? path.folder : (folder ?? undefined);
    const { tags: _previous, folder: _previousFolder, ...withoutFiling } = path;
    const saved = store.savePath({
      ...withoutFiling,
      updatedAt: new Date().toISOString(),
      ...(tags.length === 0 ? {} : { tags }),
      ...(nextFolder === undefined ? {} : { folder: nextFolder }),
    });
    emit(EVENT_PATHS_CHANGED, {
      id: saved.id,
      updatedAt: saved.updatedAt,
    });
    return { path: saved };
  });

  // ---- Error Ledger and advisory pivots -----------------------------------

  handle("errors.update", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "errors.update");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    const nodeId = readText(value.nodeId, "nodeId", { max: 128 });
    const errorId = readText(value.errorId, "errorId", { max: 128 });
    const hasResolved = value.resolved !== undefined;
    const hasNotes = Object.prototype.hasOwnProperty.call(value, "notes");
    if (!hasResolved && !hasNotes) throw new Error("errors.update needs resolved or notes.");

    const resolved = hasResolved ? readBoolean(value.resolved, "resolved") : undefined;
    let notes: string | null | undefined;
    if (hasNotes) {
      if (value.notes === null) {
        notes = null;
      } else {
        if (typeof value.notes !== "string") throw new Error("notes must be a string or null.");
        const trimmed = value.notes.trim();
        if (trimmed.length === 0) throw new Error("notes must not be blank.");
        if (trimmed.length > 2000) throw new Error("notes must be at most 2000 characters.");
        notes = trimmed;
      }
    }

    const path = store.path(pathId);
    if (!path) throw new Error(`Unknown path: ${pathId}`);
    const now = new Date().toISOString();
    const saved = store.savePath(
      updateErrorEntry(
        path,
        nodeId,
        errorId,
        {
          ...(resolved === undefined ? {} : { resolved }),
          ...(notes === undefined ? {} : { notes }),
        },
        now,
      ),
    );
    const entry = saved.modules
      .flatMap((module) => module.nodes)
      .find((node) => node.id === nodeId)
      ?.errors.find((candidate) => candidate.id === errorId);
    emit(EVENT_PATHS_CHANGED, { id: saved.id, nodeId, errorId, updatedAt: saved.updatedAt });
    return { path: saved, error: entry ?? null };
  });

  handle("pivots.resolve", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "pivots.resolve");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    const nodeId = readText(value.nodeId, "nodeId", { max: 128 });
    const pivotId = readText(value.pivotId, "pivotId", { max: 128 });
    const action = readPivotAction(value.action);
    const path = store.path(pathId);
    if (!path) throw new Error(`Unknown path: ${pathId}`);

    const now = new Date().toISOString();
    const resolution = resolvePivotSuggestion(
      path,
      nodeId,
      pivotId,
      action,
      now,
      randomUUID(),
    );
    if (!resolution.changed) {
      return {
        path,
        pivot: resolution.pivot,
        insertedNode: resolution.insertedNode,
        changed: false,
      };
    }
    const saved = store.savePath(resolution.path);
    emit(EVENT_PATHS_CHANGED, { id: saved.id, nodeId, pivotId, updatedAt: saved.updatedAt });
    return {
      path: saved,
      pivot: resolution.pivot,
      insertedNode: resolution.insertedNode,
      changed: true,
    };
  });

  // Path deletion touches only plugin-owned records and orphaned converted
  // uploads. Native chats and Knowledge Graph records stay host-owned.
  handle("paths.delete", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const pathId = readText(object(input, "paths.delete").pathId, "pathId", { max: 128 });
    const path = store.path(pathId);
    if (!path) {
      return {
        deleted: false,
        pathId,
        removedSources: [] as string[],
        retainedSources: [] as string[],
        preservedChats: 0,
        knowledgeGraphRecordsChanged: 0,
      };
    }

    const sourceIds = sourceIdsForPath(path);
    const chatIds = new Set(
      path.modules
        .flatMap((module) => module.nodes)
        .flatMap((node) => node.childSessions.map((link) => link.chatId)),
    );
    const deleted = store.deletePath(pathId);

    const stillReferenced = new Set(store.paths().flatMap(sourceIdsForPath));
    const removedSources: string[] = [];
    const retainedSources: string[] = [];
    for (const sourceId of sourceIds) {
      if (stillReferenced.has(sourceId)) {
        retainedSources.push(sourceId);
        continue;
      }
      store.removeSource(sourceId);
      removedSources.push(sourceId);
    }

    if (deleted) emit(EVENT_PATHS_CHANGED, { id: pathId, deleted: true });
    return {
      deleted,
      pathId,
      removedSources,
      retainedSources,
      preservedChats: chatIds.size,
      knowledgeGraphRecordsChanged: 0,
    };
  });

  handle("sources.list", () => ({ sources: store.sources() }));
  handle("sources.save", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "sources.save");
    const name = readText(value.name, "name", { max: 300, trim: true });
    const markdown = readText(value.markdown, "markdown", { max: MAX_SOURCE_BYTES });
    const saved = store.saveSource({ name, markdown });
    emit(EVENT_SOURCES_CHANGED, {
      sourceId: saved.reference.sourceId,
      deduplicated: saved.deduplicated,
    });
    return saved;
  });

  // ---- Workspace (learner-owned material) ---------------------------------

  // Learner items are created, edited, linked and deleted only through these
  // frontend RPCs: no agent tool ever writes a learner workspace item. The
  // manifest is the index; files under workspaces/<pathId>/files/ are the truth.
  handle("workspace.list", (input) => {
    const pathId = readText(object(input, "workspace.list").pathId, "pathId", { max: 128 });
    if (!store.path(pathId)) throw new Error(`Unknown path: ${pathId}`);
    return { workspace: store.workspace(pathId) };
  });

  // Bidirectional sync: files are the truth. The manifest re-hydrates from
  // the content files — an external edit to a file's frontmatter or body wins,
  // and a file the learner added outside the harness materializes as an
  // item. The hub calls this on every refresh, so the ledger reflects the
  // learner's editor the next time anyone looks; the change notification lets
  // any other open window refetch too.
  handle("workspace.resync", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "workspace.resync");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    if (!store.path(pathId)) throw new Error(`Unknown path: ${pathId}`);
    const { changed } = store.syncWorkspaceFromFiles(pathId);
    if (changed) emit(EVENT_WORKSPACE_CHANGED, { pathId });
    return { workspace: store.workspace(pathId), changed };
  });

  handle("workspace.saveNote", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "workspace.saveNote");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    if (!store.path(pathId)) throw new Error(`Unknown path: ${pathId}`);
    const title = readText(value.title, "title", {
      max: MAX_WORKSPACE_ITEM_TITLE_LENGTH,
      trim: true,
    });
    // Verbatim: never trimmed, normalized or converted. The learner's editor is
    // the source of truth for their own writing; the workspace stores it as-is.
    // The bound counts characters here; the store enforces the byte cap.
    const markdown = readText(value.markdown, "markdown", { max: MAX_WORKSPACE_NOTE_BYTES });
    if (markdown.trim().length === 0) throw new Error("markdown must not be blank.");
    const caption =
      value.caption === undefined
        ? undefined
        : readText(value.caption, "caption", { max: 2000, trim: true });
    const nodeId = value.nodeId === undefined ? undefined : readText(value.nodeId, "nodeId", { max: 128 });
    const rel = value.rel === undefined ? "informs" : readLinkRel(value.rel);
    // The pop-out pane files a note against several nodes at once: an explicit
    // links array wins when present; nodeId/rel stay the single-node shorthand.
    // The store validates every link against real node ids on write.
    if (value.links !== undefined && !Array.isArray(value.links)) {
      throw new Error("links must be an array.");
    }
    const links = value.links === undefined
      ? nodeId === undefined
        ? []
        : [{ to: nodeId, rel }]
      : value.links;
    const item = store.saveWorkspaceItem(
      pathId,
      {
        kind: "note",
        title,
        addedBy: "learner",
        links,
        ...(caption === undefined ? {} : { caption }),
      },
      markdown,
    );
    emit(EVENT_WORKSPACE_CHANGED, { pathId, itemId: item.id });
    return { item };
  });

  // Generalized uploads (phase 4): one converted document is filed as a
  // node-linked source item in one learner write. sources/ stays the single
  // global store — the manifest entry references the sourceId and never copies
  // content — so hash deduplication and the Architect's chunk tools keep working
  // unchanged. A document already filed under this path returns its item
  // unchanged; link edits go through workspace.updateItemMeta.
  handle("workspace.saveSource", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "workspace.saveSource");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    if (!store.path(pathId)) throw new Error(`Unknown path: ${pathId}`);
    const name = readText(value.name, "name", { max: 300, trim: true });
    const markdown = readText(value.markdown, "markdown", { max: MAX_SOURCE_BYTES });
    // The title defaults to the document name; a manifest title is capped shorter
    // than a source name, so an unsupplied long name is truncated once here.
    const title = value.title === undefined
      ? name.slice(0, MAX_WORKSPACE_ITEM_TITLE_LENGTH)
      : readText(value.title, "title", { max: MAX_WORKSPACE_ITEM_TITLE_LENGTH, trim: true });
    if (value.links !== undefined && !Array.isArray(value.links)) {
      throw new Error("links must be an array.");
    }
    const links = value.links ?? [];
    const saved = store.saveSource({ name, markdown });
    const existing = store
      .workspace(pathId)
      ?.items.find((item) => item.kind === "source" && item.sourceId === saved.reference.sourceId);
    if (existing) {
      return { item: existing, reference: saved.reference, deduplicated: true, alreadyFiled: true };
    }
    const item = store.saveWorkspaceItem(pathId, {
      kind: "source",
      title,
      sourceId: saved.reference.sourceId,
      addedBy: "learner",
      links,
    });
    if (!saved.deduplicated) {
      emit(EVENT_SOURCES_CHANGED, { sourceId: saved.reference.sourceId, deduplicated: false });
    }
    emit(EVENT_WORKSPACE_CHANGED, { pathId, itemId: item.id });
    return { item, reference: saved.reference, deduplicated: saved.deduplicated, alreadyFiled: false };
  });

  /** Bounded read: content files are capped at MAX_WORKSPACE_NOTE_BYTES on
   * write, source items reference the global sources store and carry no file. */
  handle("workspace.readItem", (input) => {
    const value = object(input, "workspace.readItem");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    if (!store.path(pathId)) throw new Error(`Unknown path: ${pathId}`);
    const itemId = readText(value.itemId, "itemId", { max: 128 });
    const item = store.workspace(pathId)?.items.find((candidate) => candidate.id === itemId) ?? null;
    if (!item) throw new Error(`Unknown workspace item: ${itemId}`);
    return { item, content: store.readWorkspaceItemContent(pathId, itemId) };
  });

  // Learner filing only: title, caption and link relations. Nothing here ever
  // touches progression, ordering or any scheduling semantics.
  handle("workspace.updateItemMeta", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "workspace.updateItemMeta");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    if (!store.path(pathId)) throw new Error(`Unknown path: ${pathId}`);
    const itemId = readText(value.itemId, "itemId", { max: 128 });
    const changes: Record<string, unknown> = {};
    if (value.title !== undefined) {
      changes.title = readText(value.title, "title", {
        max: MAX_WORKSPACE_ITEM_TITLE_LENGTH,
        trim: true,
      });
    }
    if (value.caption !== undefined) {
      changes.caption =
        value.caption === null
          ? null
          : readText(value.caption, "caption", { max: 2000, trim: true });
    }
    if (value.links !== undefined) {
      if (!Array.isArray(value.links)) throw new Error("links must be an array.");
      changes.links = value.links;
    }
    if (Object.keys(changes).length === 0) {
      throw new Error("workspace.updateItemMeta needs title, caption or links.");
    }
    const item: WorkspaceItem = store.updateWorkspaceItemMeta(pathId, itemId, changes);
    emit(EVENT_WORKSPACE_CHANGED, { pathId, itemId });
    return { item };
  });

  handle("workspace.deleteItem", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "workspace.deleteItem");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    if (!store.path(pathId)) throw new Error(`Unknown path: ${pathId}`);
    const itemId = readText(value.itemId, "itemId", { max: 128 });
    const deleted = store.deleteWorkspaceItem(pathId, itemId);
    if (deleted) emit(EVENT_WORKSPACE_CHANGED, { pathId, itemId, deleted: true });
    return { deleted };
  });

  // Open the path's workspace folder in the host OS file manager. The folder
  // materializes on demand so an empty workspace opens too; the manifest and
  // content files stay learner material, never agent-visible data.
  handle("workspace.openDirectory", async (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "workspace.openDirectory");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    if (!store.path(pathId)) throw new Error(`Unknown path: ${pathId}`);
    const directory = store.ensureWorkspaceDirectory(pathId);
    await openInFileManager(directory);
    return { directory };
  });

  // Hand one item's content file to the OS: the learner's chosen application
  // opens it (the OS prompts for one wherever no default is registered), and
  // whatever the editor writes back lands through workspace.resync. The file
  // keeps its frontmatter; sources carry no file of their own and are refused.
  handle("workspace.openItem", async (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "workspace.openItem");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    if (!store.path(pathId)) throw new Error(`Unknown path: ${pathId}`);
    const itemId = readText(value.itemId, "itemId", { max: 128 });
    const file = store.workspaceItemFile(pathId, itemId);
    if (!file) {
      throw new Error(`The workspace item carries no content file to open: ${itemId}`);
    }
    await openInApplication(file);
    return { file };
  });

  // ---- Child sessions -----------------------------------------------------

  /** Build the opening prompt and title before a native chat is created. */
  handle("sessions.prepare", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "sessions.prepare");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    const nodeId = readText(value.nodeId, "nodeId", { max: 128 });
    const kind = readKind(value.kind);
    const path = store.path(pathId);
    if (!path) throw new Error(`Unknown path: ${pathId}`);
    const node = findNodeById(path, nodeId);
    if (!node) throw new Error(`Unknown node: ${nodeId}`);
    // This prompt is staged as a visible user message. Never read/pass graph
    // propositions here: private graph context is delivered by get_brief only.
    const brief = buildChildSessionBrief({
      path,
      nodeId,
      kind,
      settings: store.settings(),
      workspace: store.workspace(pathId),
    });
    return {
      pathId: path.id,
      pathTitle: path.title,
      nodeId: node.id,
      nodeTitle: node.title,
      kind,
      title: `${kind === "teaching" ? "Teaching" : "Practice"}: ${node.title}`,
      prompt: brief.text,
      watchpoints: brief.watchpoints.length,
    };
  });

  /** Link an existing native chat to one node; never creates or mutates the chat. */
  handle("sessions.link", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "sessions.link");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    const nodeId = readText(value.nodeId, "nodeId", { max: 128 });
    const chatId = readText(value.chatId, "chatId", { max: 128 });
    const kind = readKind(value.kind);
    const label =
      value.label === undefined
        ? undefined
        : readText(value.label, "label", { max: 200, trim: true });

    const record = nativeSession(ctx, chatId);
    if (!record) {
      throw new Error(
        `Native chat "${chatId}" no longer exists. Open or create a session first, then attach it.`,
      );
    }
    if (nativeKind(record) !== kind) {
      throw new Error(
        `Native chat "${chatId}" is a ${nativeKind(record)} session, not ${kind}.`,
      );
    }

    const existing = findChatLink(store.paths(), chatId);
    if (existing) {
      if (existing.path.id === pathId && existing.node.id === nodeId) {
        return { path: existing.path, link: existing.link, deduplicated: true };
      }
      throw new Error(
        `Native chat "${chatId}" is already linked to "${existing.node.title}" in "${existing.path.title}".`,
      );
    }

    const path = store.path(pathId);
    if (!path) throw new Error(`Unknown path: ${pathId}`);
    const node = findNodeById(path, nodeId);
    if (!node) throw new Error(`Unknown node: ${nodeId}`);

    const now = new Date().toISOString();
    const link = {
      chatId,
      kind,
      createdAt: now,
      label: label ?? (record.title.trim().slice(0, 200) || `${kind} session`),
    };
    const saved = store.savePath(addChildLink(path, nodeId, link, now));
    emit(EVENT_PATHS_CHANGED, { id: saved.id, nodeId, chatId, updatedAt: saved.updatedAt });
    return { path: saved, link, deduplicated: false };
  });

  /** Remove a stale link; the native chat is untouched. */
  handle("sessions.unlink", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "sessions.unlink");
    const pathId = readText(value.pathId, "pathId", { max: 128 });
    const nodeId = readText(value.nodeId, "nodeId", { max: 128 });
    const chatId = readText(value.chatId, "chatId", { max: 128 });
    const path = store.path(pathId);
    if (!path) throw new Error(`Unknown path: ${pathId}`);
    const node = findNodeById(path, nodeId);
    if (!node) throw new Error(`Unknown node: ${nodeId}`);
    const linked = node.childSessions.some((candidate) => candidate.chatId === chatId);
    const saved = store.savePath(
      removeChildLink(path, nodeId, chatId, new Date().toISOString()),
    );
    if (linked) {
      emit(EVENT_PATHS_CHANGED, { id: saved.id, nodeId, chatId, updatedAt: saved.updatedAt });
    }
    return { path: saved, removed: linked };
  });

  /** The parent node for a native session's top-bar action, or null. */
  handle("sessions.forChat", (input) => {
    const chatId = readText(object(input, "sessions.forChat").chatId, "chatId", { max: 128 });
    const located = findChatLink(store.paths(), chatId);
    if (!located) return { link: null, exists: nativeSession(ctx, chatId) !== null };
    return {
      exists: nativeSession(ctx, chatId) !== null,
      link: {
        pathId: located.path.id,
        pathTitle: located.path.title,
        nodeId: located.node.id,
        nodeTitle: located.node.title,
        kind: located.link.kind,
        label: located.link.label,
        chatId: located.link.chatId,
        createdAt: located.link.createdAt,
      },
    };
  });

  /** Read a bounded learner-approved handoff preview for creating a new path. */
  handle("sessions.toPathPreview", (input) => {
    const value = object(input, "sessions.toPathPreview");
    const chatId = readText(value.chatId, "chatId", { max: 128 });
    if (store.settings().chatToPathEnabled !== true) {
      throw new Error("Creating a path from a Teaching chat is disabled in Learning Path settings.");
    }
    const record = nativeSession(ctx, chatId);
    if (!record) throw new Error(`Native chat "${chatId}" no longer exists.`);
    if (nativeKind(record) !== "teaching") {
      throw new Error("Only Teaching chats can be used to create a Learning Path.");
    }
    const listed = ctx.learning.listSessions().find((session) => session.id === chatId);
    const nodes = record.tree?.nodes ?? [];
    let outline = "";
    let truncated = nodes.length > 20;
    for (const node of nodes.slice(0, 20)) {
      const label = node.title.trim();
      if (!label) continue;
      const separator = outline ? " · " : "";
      const room = 2_000 - outline.length;
      if (separator.length + label.length > room) {
        if (room > separator.length) outline += separator + label.slice(0, room - separator.length);
        truncated = true;
        break;
      }
      outline += separator + label;
    }
    const title = record.title.length > 200 ? `${record.title.slice(0, 199)}…` : record.title;
    const revision = createHash("sha256").update(JSON.stringify([
      chatId, record.updatedAt, record.tree?.version, title, outline, truncated,
    ])).digest("hex");
    return {
      title, busy: listed?.busy === true || listed?.compacting === true,
      outline: outline || null, truncated, revision,
    } satisfies ChatPathPreview;
  });

  /** Native sessions that can be attached; `linked` makes duplicates obvious. */
  handle("sessions.available", () => {
    const sessions = ctx.learning.listSessions().map((chat) => {
      const located = findChatLink(store.paths(), chat.id);
      return {
        chatId: chat.id,
        title: chat.title,
        kind: nativeKind(chat),
        updatedAt: chat.updatedAt,
        messageCount: chat.messageCount,
        busy: chat.busy,
        linked:
          located === null
            ? null
            : {
                pathId: located.path.id,
                pathTitle: located.path.title,
                nodeId: located.node.id,
                nodeTitle: located.node.title,
                kind: located.link.kind,
              },
      };
    });
    return { sessions };
  });

  /** Existence of every linked chat, for missing/relink UI in the Path Hub. */
  handle("sessions.status", (input) => {
    const pathId = readText(object(input, "sessions.status").pathId, "pathId", { max: 128 });
    const path = store.path(pathId);
    if (!path) throw new Error(`Unknown path: ${pathId}`);
    const seen = new Map<
      string,
      {
        chatId: string;
        kind: ChildSessionKind;
        label: string;
        exists: boolean;
        title: string | null;
        updatedAt: string | null;
      }
    >();
    for (const node of path.modules.flatMap((module) => module.nodes)) {
      for (const link of node.childSessions) {
        if (seen.has(link.chatId)) continue;
        const record = nativeSession(ctx, link.chatId);
        seen.set(link.chatId, {
          chatId: link.chatId,
          kind: link.kind,
          label: link.label,
          exists: record !== null,
          title: record?.title ?? null,
          updatedAt: record?.updatedAt ?? null,
        });
      }
    }
    return { sessions: [...seen.values()] };
  });

  handle("architect.create", async (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = input === undefined ? {} : object(input, "architect.create");
    const requestId =
      value.requestId === undefined ? null : readRequestId(value.requestId);
    if (requestId) {
      const existing = createRequests.get(requestId);
      if (existing) {
        try {
          return { conversation: ctx.agents.get(existing), deduplicated: true };
        } catch {
          createRequests.delete(requestId);
        }
      }
    }
    debug("architect.create.request", { requestId });
    const model = await resolveModel(value.model);
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    ensureRegistered(model);
    debug("architect.create.model", { provider: model.provider, id: model.id });
    const chatHandoff = value.origin === "teaching-chat";
    if (chatHandoff) {
      if (store.settings().chatToPathEnabled !== true) throw new Error("Teaching-chat path creation is disabled.");
      registerChatArchitect(model);
    }
    const conversation = ctx.agents.create(chatHandoff ? CHAT_PATH_ARCHITECT_ID : ARCHITECT_DEFINITION_ID);
    if (!chatHandoff) activeChatId = conversation.id;
    watch(conversation.id);
    if (requestId) {
      createRequests.set(requestId, conversation.id);
      if (createRequests.size > MAX_CREATE_REQUESTS) {
        const oldest = createRequests.keys().next().value;
        if (oldest !== undefined) createRequests.delete(oldest);
      }
    }
    emit(EVENT_ARCHITECT_CHANGED, {
      id: conversation.id,
      kind: "created",
      status: conversation.status,
    });
    return { conversation, deduplicated: false };
  });

  handle("architect.list", () => ({ conversations: ctx.agents.list() }));

  handle("architect.get", (input) => {
    const id = readText(object(input, "architect.get").id, "id", { max: 128 });
    const conversation = ctx.agents.get(id);
    watch(id);
    return { conversation };
  });

  // Stream ticks read live state only; committed history comes from architect.get.
  handle("architect.progress", (input) => {
    const id = readText(object(input, "architect.progress").id, "id", { max: 128 });
    const snapshot = latestSnapshots.get(id) ?? ctx.agents.get(id);
    watch(id);
    const progress: ArchitectProgress = {
      id: snapshot.id,
      status: snapshot.status,
      ...(snapshot.error === undefined ? {} : { error: snapshot.error }),
      pending: snapshot.pending,
      updatedAt: snapshot.updatedAt,
      messageCount: snapshot.messages.length,
      ...(snapshot.partial === undefined ? {} : { partial: snapshot.partial }),
    };
    return { progress };
  });

  handle("architect.send", async (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "architect.send");
    const id = readText(value.id, "id", { max: 128 });
    const text = readText(value.text, "text", { max: MAX_MESSAGE_CHARS });
    if (text.trim().length === 0) throw new Error("text must not be blank.");
    const requestId = readRequestId(value.requestId);
    if (ctx.agents.get(id).definitionId === ARCHITECT_DEFINITION_ID) activeChatId = id;
    watch(id);
    debug("architect.send.request", { id, requestId, characters: text.length });
    const conversation = await ctx.agents.send(id, text, { requestId, purpose: "user" });
    debug("architect.send.accepted", { id, status: conversation.status });
    emit(EVENT_ARCHITECT_CHANGED, {
      id: conversation.id,
      kind: "sent",
      status: conversation.status,
    });
    return { conversation };
  });

  handle("architect.approveChatPath", (input) => {
    const value = object(input, "architect.approveChatPath");
    const id = readText(value.id, "id", { max: 128 });
    const toolCallId = readText(value.toolCallId, "toolCallId", { max: 256 });
    const review = reviewableChatPath(ctx.agents.get(id));
    if (review?.toolCallId !== toolCallId) throw new Error("No current Architect proposal matches that approval.");
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const path = approveChatPathProposal(store, id, review.proposal);
    emit(EVENT_PATHS_CHANGED, { id: path.id, created: review.proposal.baseRevision === null, updatedAt: path.updatedAt });
    return { path };
  });

  handle("architect.abort", (input) => {
    if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down.");
    const value = object(input, "architect.abort");
    const id = readText(value.id, "id", { max: 128 });
    // Aborting an idle/interrupted run is already a no-op; a retried request ID is accepted.
    if (value.requestId !== undefined) readRequestId(value.requestId);
    ctx.agents.abort(id);
    const conversation = ctx.agents.get(id);
    if (conversation.definitionId === ARCHITECT_DEFINITION_ID) activeChatId = id;
    watch(id);
    emit(EVENT_ARCHITECT_CHANGED, {
      id,
      kind: "aborted",
      status: conversation.status,
    });
    return { conversation };
  });

  // Reconstruct the persistent definition from plugin data. An explicit settings
  // override wins; otherwise the saved model is registered and the first create
  // re-resolves the host slot when the learner follows it.
  const savedModel = store.architectModel();
  const activationModel = preferenceModel(store.settings().architect) ?? savedModel;
  if (activationModel && !ctx.signal.aborted) {
    registerModel(activationModel);
  }
}
