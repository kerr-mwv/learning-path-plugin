/** Minimal in-process host for backend integration tests.
 *
 * It implements only the public PluginBackendContext surface the Learning Path
 * backend uses, with the same contracts: definitions must be registered before
 * create, `send` is accepted rather than completed, an accepted `requestId`
 * never submits twice, and abort retains records. No model request is made.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ChatListItem,
  GraphNode,
  ChatRecord,
  ModelCatalogResponse,
  PluginAgentDefinition,
  PluginAgentInputOptions,
  PluginAgentSnapshot,
  PluginBackendContext,
  PluginInstructions,
  PluginManifest,
  PluginToolContext,
  PluginTools,
} from "learnharness-plugin-api";
import { activate } from "../src/backend.ts";

export const MANIFEST: PluginManifest = {
  apiVersion: 1,
  id: "learning-path",
  name: "Learning Paths",
  version: "0.1.0",
  minAppVersion: "0.6.0",
  main: "main.js",
  backend: "backend.cjs",
  styles: "styles.css",
};

export const DEFAULT_CATALOG: ModelCatalogResponse = {
  models: [
    {
      id: "architect-model",
      name: "Architect model",
      provider: "test",
      reasoning: true,
      input: ["text"],
      supportedLevels: ["off", "low", "medium", "high"],
      cost: null,
      contextWindow: 128_000,
      maxTokens: 8_000,
    },
    {
      id: "other-model",
      name: "Other model",
      provider: "test",
      reasoning: false,
      input: ["text"],
      supportedLevels: ["off"],
      cost: null,
      contextWindow: 32_000,
      maxTokens: 4_000,
    },
  ],
  defaults: { model: { provider: "test", id: "architect-model" }, thinkingLevel: "medium" },
  rolePins: {} as ModelCatalogResponse["rolePins"],
  slots: {} as ModelCatalogResponse["slots"],
  providers: [{ id: "test", envVar: "TEST_API_KEY", keyPresent: true }],
};

export interface EmittedEvent {
  readonly topic: string;
  readonly data: unknown;
}

export interface TestHost {
  readonly ctx: PluginBackendContext;
  readonly dataDirectory: string;
  readonly handlers: Map<string, (input: unknown) => unknown | Promise<unknown>>;
  readonly definitions: Map<string, PluginAgentDefinition>;
  readonly records: Map<string, PluginAgentSnapshot>;
  readonly chats: Map<string, ChatRecord>;
  readonly instructions: PluginInstructions[];
  readonly toolContributions: PluginTools[];
  readonly registered: string[];
  readonly unregistered: string[];
  readonly abortedCalls: string[];
  readonly events: EmittedEvent[];
  readonly controller: AbortController;
  call<T = unknown>(name: string, input?: unknown): Promise<T>;
  tool(name: string): NonNullable<PluginAgentDefinition["tools"]>[number];
  runTool<T = unknown>(name: string, args: unknown): Promise<T>;
  nativeTools(chatId: string, agent: PluginToolContext["agent"]): ReturnType<PluginTools["create"]>;
  addChat(record: ChatRecord): void;
  removeChat(chatId: string): boolean;
  cleanup(): Promise<void>;
  close(): void;
}

export interface HostOptions {
  readonly dataDirectory?: string;
  readonly catalog?: ModelCatalogResponse;
  readonly chats?: readonly ChatRecord[];
  readonly graphNodes?: readonly GraphNode[];
}

export function createHost(options: HostOptions = {}): TestHost {
  const dataDirectory =
    options.dataDirectory ?? fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-host-"));
  const ownDirectory = options.dataDirectory === undefined;
  const catalog = options.catalog ?? DEFAULT_CATALOG;
  const chats = new Map<string, ChatRecord>();
  for (const chat of options.chats ?? []) chats.set(chat.id, structuredClone(chat));
  const instructions: PluginInstructions[] = [];
  const toolContributions: PluginTools[] = [];
  const controller = new AbortController();
  const handlers = new Map<string, (input: unknown) => unknown | Promise<unknown>>();
  const definitions = new Map<string, PluginAgentDefinition>();
  const records = new Map<string, PluginAgentSnapshot>();
  const listeners = new Map<string, Set<(snapshot: PluginAgentSnapshot) => void>>();
  const cleanups: (() => void | Promise<void>)[] = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  const abortedCalls: string[] = [];
  const events: EmittedEvent[] = [];
  let sequence = 0;

  const now = (): string => new Date().toISOString();
  const clone = (snapshot: PluginAgentSnapshot): PluginAgentSnapshot => structuredClone(snapshot);

  const publish = (snapshot: PluginAgentSnapshot): void => {
    for (const listener of listeners.get(snapshot.id) ?? []) listener(clone(snapshot));
  };

  const requireRecord = (id: string): PluginAgentSnapshot => {
    const record = records.get(id);
    if (!record) throw new Error(`Unknown conversation: ${id}`);
    return record;
  };

  const agents: PluginBackendContext["agents"] = {
    register(definition) {
      if (definitions.has(definition.id)) throw new Error(`Duplicate definition: ${definition.id}`);
      definitions.set(definition.id, definition);
      registered.push(definition.id);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        unregistered.push(definition.id);
        if (definitions.get(definition.id) === definition) definitions.delete(definition.id);
      };
    },
    create(definitionId) {
      if (!definitions.has(definitionId)) throw new Error(`Unknown definition: ${definitionId}`);
      sequence += 1;
      const stamp = now();
      const record: PluginAgentSnapshot = {
        version: 1,
        id: `conversation-${sequence}`,
        definitionId,
        createdAt: stamp,
        updatedAt: stamp,
        messages: [],
        pending: [],
        status: "idle",
        acceptedInputs: [],
      };
      records.set(record.id, record);
      publish(record);
      return clone(record);
    },
    list: () => [...records.values()].map(clone),
    get(id) {
      return clone(requireRecord(id));
    },
    send(id, text, inputOptions: PluginAgentInputOptions) {
      const record = requireRecord(id);
      if (record.acceptedInputs.includes(inputOptions.requestId)) return Promise.resolve(clone(record));
      if (record.status === "running") return Promise.reject(new Error("Conversation is busy."));
      if (!text.trim()) return Promise.reject(new Error("Text must not be blank."));
      record.acceptedInputs.push(inputOptions.requestId);
      record.messages.push({ role: "user", content: text, timestamp: Date.now() });
      record.status = "running";
      record.updatedAt = now();
      publish(record);
      return Promise.resolve(clone(record));
    },
    answer() {
      return Promise.reject(new Error("Not used by the Learning Path backend tests."));
    },
    run(id) {
      return Promise.resolve(clone(requireRecord(id)));
    },
    abort(id) {
      abortedCalls.push(id);
      const record = requireRecord(id);
      if (record.status === "running") {
        record.status = "interrupted";
        record.updatedAt = now();
        publish(record);
      }
    },
    subscribe(id, listener) {
      requireRecord(id);
      const set = listeners.get(id) ?? new Set();
      set.add(listener);
      listeners.set(id, set);
      listener(clone(requireRecord(id)));
      return () => {
        set.delete(listener);
      };
    },
    dispose() {
      return Promise.resolve();
    },
  };

  const chatListItem = (chat: ChatRecord): ChatListItem => ({
    id: chat.id,
    title: chat.title,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    kind: chat.kind ?? "teach",
    messageCount: chat.messages.length,
    phase: "probe",
    pendingQuestion: false,
    pendingProblem: false,
    busy: false,
    compacting: false,
  });

  const learning: PluginBackendContext["learning"] = {
    directory: dataDirectory,
    listSessions: () => [...chats.values()].map(chatListItem),
    getSession(id) {
      if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid chat id: ${id}`);
      const found = chats.get(id);
      return found ? structuredClone(found) : null;
    },
    graph: () => ({ nodes: structuredClone(options.graphNodes ?? []), propositions: structuredClone(options.graphNodes ?? []), chains: [] }) as never,
    readGraphFile: (name) => structuredClone(name === "nodes.jsonl" ? options.graphNodes ?? [] : []) as never,
  };

  const ctx = {
    manifest: MANIFEST,
    directory: path.join(dataDirectory, "code"),
    dataDirectory,
    signal: controller.signal,
    cleanup: (dispose: () => void | Promise<void>) => cleanups.push(dispose),
    learning,
    inference: {
      catalog: async () => {
        if (controller.signal.aborted) throw new Error("Activation cancelled.");
        return structuredClone(catalog);
      },
      stream: async function* stream() {
        throw new Error("No model requests in backend tests.");
      },
      complete: async () => {
        throw new Error("No model requests in backend tests.");
      },
    },
    agents,
    workers: {} as PluginBackendContext["workers"],
    createBackgroundTool: () => {
      throw new Error("Not used by the Learning Path backend tests.");
    },
    registerInstructions(contribution: PluginInstructions) {
      instructions.push(contribution);
      return () => {
        const index = instructions.indexOf(contribution);
        if (index >= 0) instructions.splice(index, 1);
      };
    },
    registerTools(contribution: PluginTools) {
      toolContributions.push(contribution);
      return () => {
        const index = toolContributions.indexOf(contribution);
        if (index >= 0) toolContributions.splice(index, 1);
      };
    },
    registerQuestionType: () => () => {},
    registerProblemType: () => () => {},
    handle(name: string, handler: (input: unknown) => unknown | Promise<unknown>) {
      if (handlers.has(name)) throw new Error(`Duplicate handler: ${name}`);
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    events: {
      on: () => () => {},
      emit(topic: string, data?: unknown) {
        if (controller.signal.aborted) throw new Error("Activation cancelled.");
        events.push({ topic, data });
      },
    },
  } as unknown as PluginBackendContext;

  activate(ctx);

  return {
    ctx,
    dataDirectory,
    handlers,
    definitions,
    records,
    chats,
    instructions,
    toolContributions,
    registered,
    unregistered,
    abortedCalls,
    events,
    controller,
    async call<T>(name: string, input?: unknown): Promise<T> {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Unknown handler: ${name}`);
      return (await handler(input)) as T;
    },
    tool(name) {
      const definition = definitions.get("path-architect");
      if (!definition) throw new Error("The Architect definition is not registered.");
      const found = (definition.tools ?? []).find((candidate) => candidate.name === name);
      if (!found) throw new Error(`Unknown Architect tool: ${name}`);
      return found;
    },
    async runTool<T>(name: string, args: unknown): Promise<T> {
      const tool = this.tool(name);
      if (!("execute" in tool) || typeof tool.execute !== "function") {
        throw new Error(`Tool ${name} has no server executor.`);
      }
      return (await tool.execute("call-1", args as never, controller.signal)) as T;
    },
    nativeTools(chatId, agent) {
      const contribution = toolContributions.find((candidate) =>
        (candidate.agents as readonly string[]).includes(agent),
      );
      if (!contribution) throw new Error(`No native tool contribution for ${agent}.`);
      return contribution.create({ chatId, agent });
    },
    addChat(record: ChatRecord) {
      chats.set(record.id, structuredClone(record));
    },
    removeChat(chatId: string) {
      return chats.delete(chatId);
    },
    async cleanup() {
      toolContributions.length = 0;
      instructions.length = 0;
      for (const dispose of cleanups.reverse()) await dispose();
    },
    close() {
      controller.abort();
      if (ownDirectory) fs.rmSync(dataDirectory, { recursive: true, force: true });
    },
  };
}
