/** In-process frontend host for Path Hub tests.
 *
 * This is a public-API test double, not a native widget substitute: it records
 * controlled mounts, mounts rich tree content the way the real host does on
 * disclosure changes, and exposes notifications/resync so tests can prove the
 * view refetches authoritative state instead of trusting event payloads.
 *
 * The backend half is an in-memory JSON exchange that mirrors the plugin's
 * `paths.*`, `architect.*` and `sources.*` operations. No model, filesystem or
 * browser page is involved.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
const { parseHTML } = createRequire(import.meta.url)("linkedom") as {
  parseHTML(html: string): { document: Document };
};
import type {
  PluginAction,
  PluginActionContext,
  PluginActionPlacement,
  PluginAgentSnapshot,
  PluginDialogProps,
  PluginFrontendContext,
  PluginMenuProps,
  PluginTreeRow,
  PluginToolRenderer,
  PluginUi,
  PluginUiContent,
  PluginView,
} from "learnharness-plugin-api";
import type { ChildSessionKind, ChildSessionLink, LearningPath, PluginSettings } from "../src/domain.ts";
import { buildChildSessionBrief } from "../src/framework.ts";
import { resolvePivotSuggestion, updateErrorEntry } from "../src/session-links.ts";
import type { PathSummary } from "../src/view/path-hub.ts";

type AnyProps = Record<string, any>;

export interface MountRecord {
  method: string;
  container: HTMLElement;
  props: AnyProps;
  signal: AbortSignal;
  disposed: number;
  updates: AnyProps[];
  treeContents: TreeContentRecord[];
  /** Dialog/dynamic content host, when the mount owns one. */
  contentContainer?: HTMLElement;
  handle: { update(props: AnyProps): void; dispose(): void };
}

export interface TreeContentRecord {
  key: string;
  content: PluginUiContent;
  container: HTMLElement;
  signal: AbortSignal;
  disposed: number;
  dispose(): void;
}

export interface CallRecord {
  name: string;
  input: unknown;
}

export interface NativeChatFixture {
  readonly id: string;
  readonly title: string;
  readonly kind?: "teach" | "practice";
  readonly updatedAt?: string;
  readonly messageCount?: number;
}

export interface ViewFixture {
  readonly root: HTMLElement;
  readonly context: PluginFrontendContext;
  readonly controller: AbortController;
  readonly records: MountRecord[];
  readonly calls: CallRecord[];
  readonly openedSessions: string[];
  readonly openedViews: string[];
  readonly actions: PluginAction[];
  readonly placements: PluginActionPlacement[];
  readonly toolRenderers: Map<string, PluginToolRenderer>;
  readonly views: PluginView[];
  readonly settingsMounts: PluginView["mount"][];
  readonly paths: Map<string, LearningPath>;
  /** Mutable plugin settings backing `settings.get`/`settings.save`. */
  settings: PluginSettings;
  readonly conversations: Map<string, PluginAgentSnapshot>;
  readonly nativeChats: Map<string, NativeChatFixture>;
  readonly uploaded: { name: string; markdown: string }[];
  /** Replace the document conversion behavior for a test. */
  toMarkdown: (file: File) => Promise<{ name: string; markdown: string; notices: string[] }>;
  find(method: string, predicate?: (record: MountRecord) => boolean): MountRecord;
  findLast(method: string, predicate?: (record: MountRecord) => boolean): MountRecord;
  all(method: string): MountRecord[];
  emit(topic: string, data?: unknown): void;
  resync(): void;
  flush(): Promise<void>;
  restore(): void;
}

function summarize(path: LearningPath): PathSummary {
  return {
    id: path.id,
    title: path.title,
    goal: path.goal,
    updatedAt: path.updatedAt,
    moduleCount: path.modules.length,
    nodeCount: path.modules.reduce((total, module) => total + module.nodes.length, 0),
    sourceMode: path.sourceSpine.mode,
    architectChatId: path.architectChatId ?? null,
  };
}

export function makeConversation(
  id: string,
  overrides: Partial<PluginAgentSnapshot> = {},
): PluginAgentSnapshot {
  const now = "2026-01-31T09:30:00.000Z";
  return {
    version: 1,
    id,
    definitionId: "path-architect",
    createdAt: now,
    updatedAt: now,
    messages: [],
    pending: [],
    status: "idle",
    acceptedInputs: [],
    ...overrides,
  };
}

function renderTreeContent(record: MountRecord): void {
  const visible = new Map<string, PluginUiContent>();
  const visit = (rows: readonly PluginTreeRow[]) => {
    for (const row of rows) {
      if (typeof row.content !== "string") visible.set(row.key, row.content);
      if (row.children && (!row.disclosure || row.disclosure.expanded)) visit(row.children);
    }
  };
  visit(record.props.rows);
  for (const mounted of record.treeContents) {
    if (!mounted.disposed && visible.get(mounted.key) !== mounted.content) mounted.dispose();
  }
  for (const [key, content] of visible) {
    if (
      record.treeContents.some(
        (mounted) => !mounted.disposed && mounted.key === key && mounted.content === content,
      )
    ) {
      continue;
    }
    const controller = new AbortController();
    const container = record.container.ownerDocument.createElement("div");
    record.container.append(container);
    let cleanup: void | (() => void);
    const mounted: TreeContentRecord = {
      key,
      content,
      container,
      signal: controller.signal,
      disposed: 0,
      dispose() {
        if (mounted.disposed) return;
        mounted.disposed += 1;
        controller.abort();
        cleanup?.();
        container.remove();
      },
    };
    record.treeContents.push(mounted);
    if (typeof content === "function") {
      const result = content(container, controller.signal);
      if (typeof result === "function") cleanup = result;
      else if (result) {
        void result.then((next: void | (() => void) | undefined) => {
          if (mounted.disposed) next?.();
          else cleanup = next;
        });
      }
    } else {
      container.append(content);
    }
  }
}

export interface FixtureOptions {
  paths?: readonly LearningPath[];
  conversations?: readonly PluginAgentSnapshot[];
  nativeChats?: readonly NativeChatFixture[];
  settings?: PluginSettings;
}

export function createViewFixture(options: FixtureOptions = {}): ViewFixture {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const { document } = parseHTML("<!doctype html><html><body><main></main></body></html>");
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  const root = document.querySelector("main") as unknown as HTMLElement;

  const controller = new AbortController();
  const records: MountRecord[] = [];
  const calls: CallRecord[] = [];
  const openedSessions: string[] = [];
  const openedViews: string[] = [];
  const actions: PluginAction[] = [];
  const placements: PluginActionPlacement[] = [];
  const toolRenderers = new Map<string, PluginToolRenderer>();
  const views: PluginView[] = [];
  const settingsMounts: PluginView["mount"][] = [];
  const nativeChats = new Map<string, NativeChatFixture>();
  for (const chat of options.nativeChats ?? []) nativeChats.set(chat.id, { ...chat });
  const paths = new Map<string, LearningPath>();
  for (const path of options.paths ?? []) paths.set(path.id, structuredClone(path));
  let settingsState: PluginSettings = options.settings ?? { artifactDefaults: {} };
  // A fixture path normally points at live chats; tests delete one to model a
  // deleted native session instead of every fixture starting "missing".
  for (const path of paths.values()) {
    for (const node of path.modules.flatMap((module) => module.nodes)) {
      for (const link of node.childSessions) {
        if (!nativeChats.has(link.chatId)) {
          nativeChats.set(link.chatId, {
            id: link.chatId,
            title: link.label,
            kind: link.kind === "practice" ? "practice" : "teach",
          });
        }
      }
    }
  }
  const conversations = new Map<string, PluginAgentSnapshot>();
  for (const snapshot of options.conversations ?? []) {
    conversations.set(snapshot.id, structuredClone(snapshot));
  }
  const uploaded: { name: string; markdown: string }[] = [];
  const notificationListeners: ((event: { pluginId: string; topic: string; data?: unknown }) => void)[] = [];
  const resyncListeners: (() => void)[] = [];
  let sequence = 0;

  let fixtures: ViewFixture;

  function mountRecord(
    method: string,
    container: HTMLElement,
    props: AnyProps,
    signal: AbortSignal,
  ): MountRecord {
    const contentLife = new AbortController();
    let contentCleanup: void | (() => void) | undefined;
    const record: MountRecord = {
      method,
      container,
      props,
      signal,
      disposed: 0,
      updates: [],
      treeContents: [],
      handle: null!,
    };
    const handle = {
      update(next: AnyProps) {
        if (record.disposed) return;
        record.updates.push(next);
        record.props = { ...record.props, ...next };
        if (method === "mountTree") renderTreeContent(record);
      },
      dispose() {
        if (record.disposed) return;
        record.disposed += 1;
        contentLife.abort();
        contentCleanup?.();
        for (const content of record.treeContents) content.dispose();
        // An openMenu anchor belongs to plugin content; closing the menu must not remove it.
        if (method !== "openMenu" && container.parentElement === root) container.remove();
      },
    };
    record.handle = handle;
    records.push(record);
    if (!signal.aborted) signal.addEventListener("abort", handle.dispose, { once: true });
    if (method === "mountTree") renderTreeContent(record);
    if (method === "openDialog") {
      const content = document.createElement("div");
      content.className = "lp-dialog-content";
      container.append(content);
      record.contentContainer = content;
      const value = props.content;
      if (typeof value === "function") {
        const result = value(content, contentLife.signal);
        if (typeof result === "function") contentCleanup = result;
        else if (result) {
          void result.then((next: void | (() => void) | undefined) => {
            if (record.disposed) next?.();
            else contentCleanup = next;
          });
        }
      } else if (value) {
        content.append(value as HTMLElement);
      }
    }
    return record;
  }

  const ui = {
    mountButton(container: HTMLElement, props: AnyProps, widget: { signal: AbortSignal }) {
      return mountRecord("mountButton", container, props, widget.signal).handle;
    },
    mountBadge(container: HTMLElement, props: AnyProps, widget: { signal: AbortSignal }) {
      return mountRecord("mountBadge", container, props, widget.signal).handle;
    },
    mountMarkdown(container: HTMLElement, props: AnyProps, widget: { signal: AbortSignal }) {
      return mountRecord("mountMarkdown", container, props, widget.signal).handle;
    },
    mountTree(container: HTMLElement, props: AnyProps, widget: { signal: AbortSignal }) {
      return mountRecord("mountTree", container, props, widget.signal).handle;
    },
    mountStandardComposer(container: HTMLElement, props: AnyProps, widget: { signal: AbortSignal }) {
      return mountRecord("mountStandardComposer", container, props, widget.signal).handle;
    },
    mountModelPicker(container: HTMLElement, props: AnyProps, widget: { signal: AbortSignal }) {
      return mountRecord("mountModelPicker", container, props, widget.signal).handle;
    },
    mountThinkingPicker(container: HTMLElement, props: AnyProps, widget: { signal: AbortSignal }) {
      return mountRecord("mountThinkingPicker", container, props, widget.signal).handle;
    },
    mountDictation(container: HTMLElement, props: AnyProps, widget: { signal: AbortSignal }) {
      return mountRecord("mountDictation", container, props, widget.signal).handle;
    },
    mountSettingsRows(container: HTMLElement, props: AnyProps, widget: { signal: AbortSignal }) {
      return mountRecord("mountSettingsRows", container, props, widget.signal).handle;
    },
    mountKnowledgePicker(container: HTMLElement, props: AnyProps, widget: { signal: AbortSignal }) {
      return mountRecord("mountKnowledgePicker", container, props, widget.signal).handle;
    },
    mountComposer(container: HTMLElement, props: AnyProps, widget: { signal: AbortSignal }) {
      return mountRecord("mountComposer", container, props, widget.signal).handle;
    },
    mountWorkerResult(container: HTMLElement, props: AnyProps, widget: { signal: AbortSignal }) {
      return mountRecord("mountWorkerResult", container, props, widget.signal).handle;
    },
    openDialog(props: PluginDialogProps, widget: { signal: AbortSignal }) {
      const host = document.createElement("div");
      host.className = "lp-dialog";
      root.append(host);
      return mountRecord("openDialog", host, props as AnyProps, widget.signal).handle;
    },
    openMenu(anchor: HTMLElement, props: PluginMenuProps, widget: { signal: AbortSignal }) {
      return mountRecord("openMenu", anchor, props as AnyProps, widget.signal).handle;
    },
  } as unknown as PluginUi;

  function findPathNode(pathId: string, nodeId: string) {
    const found = paths.get(pathId);
    if (!found) return null;
    const node = found.modules.flatMap((module) => module.nodes).find((candidate) => candidate.id === nodeId);
    return node ? { path: found, node } : null;
  }

  function findChatLink(chatId: string) {
    for (const path of paths.values()) {
      for (const node of path.modules.flatMap((module) => module.nodes)) {
        const link = node.childSessions.find((candidate) => candidate.chatId === chatId);
        if (link) return { path, node, link };
      }
    }
    return null;
  }

  function sessionKind(chat: NativeChatFixture): ChildSessionKind {
    return chat.kind === "practice" ? "practice" : "teaching";
  }

  function saveSessionLink(
    pathId: string,
    nodeId: string,
    chatId: string,
    kind: ChildSessionKind,
    label: string,
  ) {
    const located = findPathNode(pathId, nodeId);
    if (!located) return null;
    const link: ChildSessionLink = {
      chatId,
      kind,
      createdAt: "2026-02-01T00:00:00.000Z",
      label,
    };
    const updated: LearningPath = {
      ...located.path,
      updatedAt: "2026-02-01T00:00:00.000Z",
      modules: located.path.modules.map((module) => ({
        ...module,
        nodes: module.nodes.map((node) =>
          node.id === nodeId
            ? { ...node, childSessions: [...node.childSessions, link] }
            : node,
        ),
      })),
    };
    paths.set(updated.id, updated);
    return { path: updated, link };
  }

  function call<T>(name: string, input?: unknown): Promise<T> {
    calls.push({ name, input });
    const value = (input ?? {}) as AnyProps;
    switch (name) {
      case "knowledge.inspect":
        return Promise.resolve({ links: [], available: true, notice: "Graph presence is not evidence of mastery." } as T);
      case "paths.list":
        return Promise.resolve({
          paths: [...paths.values()].map(summarize),
        } as T);
      case "paths.get": {
        const found = paths.get(value.id);
        return Promise.resolve({ path: found ? structuredClone(found) : null } as T);
      }
      case "paths.updateNode": {
        const found = paths.get(value.pathId);
        if (!found) return Promise.reject(new Error(`Unknown path: ${String(value.pathId)}`));
        let foundNode = false;
        const modules = found.modules.map((module) => ({
          ...module,
          nodes: module.nodes.map((node) => {
            if (node.id !== value.nodeId) return node;
            foundNode = true;
            return {
              ...node,
              ...(value.progression === undefined ? {} : { progression: value.progression }),
              ...("artifactType" in value
                ? {
                    artifactConfig:
                      value.artifactType === null
                        ? null
                        : { type: value.artifactType },
                  }
                : {}),
            };
          }),
        }));
        if (!foundNode) return Promise.reject(new Error(`Unknown node: ${String(value.nodeId)}`));
        const updated: LearningPath = {
          ...found,
          updatedAt: "2026-02-01T00:00:00.000Z",
          modules,
        };
        paths.set(updated.id, updated);
        return Promise.resolve({ path: structuredClone(updated) } as T);
      }
      case "settings.get":
        return Promise.resolve({ settings: structuredClone(settingsState) } as T);
      case "settings.save": {
        settingsState = structuredClone(value as PluginSettings);
        fixtures.settings = settingsState;
        return Promise.resolve({ settings: structuredClone(settingsState) } as T);
      }
      case "errors.update": {
        const found = paths.get(value.pathId);
        if (!found) return Promise.reject(new Error(`Unknown path: ${String(value.pathId)}`));
        const updated = updateErrorEntry(
          found,
          String(value.nodeId),
          String(value.errorId),
          {
            ...(value.resolved === undefined ? {} : { resolved: value.resolved as boolean }),
            ...("notes" in value ? { notes: value.notes as string | null } : {}),
          },
          "2026-02-01T00:00:00.000Z",
        );
        paths.set(updated.id, updated);
        const entry = updated.modules
          .flatMap((module) => module.nodes)
          .find((node) => node.id === value.nodeId)
          ?.errors.find((candidate) => candidate.id === value.errorId) ?? null;
        return Promise.resolve({ path: structuredClone(updated), error: entry } as T);
      }
      case "pivots.resolve": {
        const found = paths.get(value.pathId);
        if (!found) return Promise.reject(new Error(`Unknown path: ${String(value.pathId)}`));
        const resolution = resolvePivotSuggestion(
          found,
          String(value.nodeId),
          String(value.pivotId),
          value.action === "accept" ? "accept" : "dismiss",
          "2026-02-01T00:00:00.000Z",
          randomUUID(),
        );
        if (resolution.changed) paths.set(resolution.path.id, resolution.path);
        return Promise.resolve({
          path: structuredClone(resolution.path),
          pivot: structuredClone(resolution.pivot),
          insertedNode: resolution.insertedNode ? structuredClone(resolution.insertedNode) : null,
          changed: resolution.changed,
        } as T);
      }
      case "paths.delete": {
        const found = paths.get(value.pathId);
        if (!found) {
          return Promise.resolve({
            deleted: false,
            removedSources: [],
            retainedSources: [],
            preservedChats: 0,
            knowledgeGraphRecordsChanged: 0,
          } as T);
        }
        const chats = new Set(
          found.modules
            .flatMap((module) => module.nodes)
            .flatMap((node) => node.childSessions.map((link) => link.chatId)),
        );
        paths.delete(found.id);
        return Promise.resolve({
          deleted: true,
          removedSources: [],
          retainedSources: [],
          preservedChats: chats.size,
          knowledgeGraphRecordsChanged: 0,
        } as T);
      }
      case "architect.create": {
        sequence += 1;
        const created = makeConversation(`conversation-${sequence}`);
        conversations.set(created.id, created);
        return Promise.resolve({ conversation: structuredClone(created) } as T);
      }
      case "architect.get": {
        const found = conversations.get(value.id);
        if (!found) return Promise.reject(new Error(`Unknown conversation: ${String(value.id)}`));
        return Promise.resolve({ conversation: structuredClone(found) } as T);
      }
      case "architect.progress": {
        const found = conversations.get(value.id);
        if (!found) return Promise.reject(new Error(`Unknown conversation: ${String(value.id)}`));
        const { messages, partial, error, ...rest } = structuredClone(found);
        return Promise.resolve({
          progress: {
            id: rest.id,
            status: rest.status,
            pending: rest.pending,
            updatedAt: rest.updatedAt,
            messageCount: messages.length,
            ...(error === undefined ? {} : { error }),
            ...(partial === undefined ? {} : { partial }),
          },
        } as T);
      }
      case "architect.send": {
        const found = conversations.get(value.id);
        if (!found) return Promise.reject(new Error(`Unknown conversation: ${String(value.id)}`));
        found.messages = [
          ...found.messages,
          { role: "user", content: value.text, timestamp: Date.now() },
        ];
        found.status = "running";
        found.updatedAt = "2026-02-01T00:00:00.000Z";
        conversations.set(found.id, found);
        return Promise.resolve({ conversation: structuredClone(found) } as T);
      }
      case "architect.abort": {
        const found = conversations.get(value.id);
        if (!found) return Promise.reject(new Error(`Unknown conversation: ${String(value.id)}`));
        found.status = "interrupted";
        found.updatedAt = "2026-02-01T00:00:00.000Z";
        conversations.set(found.id, found);
        return Promise.resolve({ conversation: structuredClone(found) } as T);
      }
      case "sessions.prepare": {
        const located = findPathNode(value.pathId, value.nodeId);
        if (!located) return Promise.reject(new Error(`Unknown node: ${String(value.nodeId)}`));
        const kind = value.kind as ChildSessionKind;
        const brief = buildChildSessionBrief({
          path: located.path,
          nodeId: located.node.id,
          kind,
        });
        return Promise.resolve({
          pathId: located.path.id,
          pathTitle: located.path.title,
          nodeId: located.node.id,
          nodeTitle: located.node.title,
          kind,
          title: `${kind === "teaching" ? "Teaching" : "Practice"}: ${located.node.title}`,
          prompt: brief.text,
          watchpoints: brief.watchpoints.length,
        } as T);
      }
      case "sessions.link": {
        const chat = nativeChats.get(value.chatId);
        if (!chat) {
          return Promise.reject(
            new Error(`Native chat "${String(value.chatId)}" no longer exists.`),
          );
        }
        const kind = value.kind as ChildSessionKind;
        if (sessionKind(chat) !== kind) {
          return Promise.reject(
            new Error(`Native chat "${chat.id}" is a ${sessionKind(chat)} session, not ${kind}.`),
          );
        }
        const existing = findChatLink(chat.id);
        if (existing) {
          if (existing.path.id === value.pathId && existing.node.id === value.nodeId) {
            return Promise.resolve({
              path: structuredClone(existing.path),
              link: existing.link,
              deduplicated: true,
            } as T);
          }
          return Promise.reject(
            new Error(`Native chat "${chat.id}" is already linked to "${existing.node.title}".`),
          );
        }
        const saved = saveSessionLink(
          value.pathId,
          value.nodeId,
          chat.id,
          kind,
          String(value.label ?? chat.title),
        );
        if (!saved) return Promise.reject(new Error(`Unknown node: ${String(value.nodeId)}`));
        return Promise.resolve({ path: structuredClone(saved.path), link: saved.link } as T);
      }
      case "sessions.unlink": {
        const located = findPathNode(value.pathId, value.nodeId);
        if (!located) return Promise.reject(new Error(`Unknown node: ${String(value.nodeId)}`));
        const removed = located.node.childSessions.some(
          (candidate) => candidate.chatId === value.chatId,
        );
        const updated: LearningPath = {
          ...located.path,
          modules: located.path.modules.map((module) => ({
            ...module,
            nodes: module.nodes.map((node) =>
              node.id === value.nodeId
                ? {
                    ...node,
                    childSessions: node.childSessions.filter(
                      (candidate) => candidate.chatId !== value.chatId,
                    ),
                  }
                : node,
            ),
          })),
        };
        paths.set(updated.id, updated);
        return Promise.resolve({ path: structuredClone(updated), removed } as T);
      }
      case "sessions.forChat": {
        const located = findChatLink(String(value.chatId));
        if (!located) {
          return Promise.resolve({ link: null, exists: nativeChats.has(String(value.chatId)) } as T);
        }
        return Promise.resolve({
          exists: nativeChats.has(String(value.chatId)),
          link: {
            chatId: located.link.chatId,
            pathId: located.path.id,
            pathTitle: located.path.title,
            nodeId: located.node.id,
            nodeTitle: located.node.title,
            kind: located.link.kind,
            label: located.link.label,
            createdAt: located.link.createdAt,
          },
        } as T);
      }
      case "sessions.available": {
        return Promise.resolve({
          sessions: [...nativeChats.values()].map((chat) => {
            const located = findChatLink(chat.id);
            return {
              chatId: chat.id,
              title: chat.title,
              kind: sessionKind(chat),
              updatedAt: chat.updatedAt ?? "2026-02-01T00:00:00.000Z",
              messageCount: chat.messageCount ?? 0,
              busy: false,
              linked: located
                ? {
                    pathId: located.path.id,
                    pathTitle: located.path.title,
                    nodeId: located.node.id,
                    nodeTitle: located.node.title,
                    kind: located.link.kind,
                  }
                : null,
            };
          }),
        } as T);
      }
      case "sessions.status": {
        const found = paths.get(value.pathId);
        if (!found) return Promise.reject(new Error(`Unknown path: ${String(value.pathId)}`));
        const seen = new Map<string, AnyProps>();
        for (const node of found.modules.flatMap((module) => module.nodes)) {
          for (const link of node.childSessions) {
            if (seen.has(link.chatId)) continue;
            const chat = nativeChats.get(link.chatId);
            seen.set(link.chatId, {
              chatId: link.chatId,
              kind: link.kind,
              label: link.label,
              exists: chat !== undefined,
              title: chat?.title ?? null,
              updatedAt: chat?.updatedAt ?? null,
            });
          }
        }
        return Promise.resolve({ sessions: [...seen.values()] } as T);
      }
      case "sources.list":
        return Promise.resolve({ sources: [...uploaded] } as T);
      case "sources.save": {
        uploaded.push({ name: value.name, markdown: value.markdown });
        return Promise.resolve({
          reference: { sourceId: `source-${uploaded.length}`, name: value.name },
          deduplicated: false,
        } as T);
      }
      default:
        return Promise.reject(new Error(`Unexpected operation: ${name}`));
    }
  }

  const context = {
    manifest: {
      apiVersion: 1,
      id: "learning-path",
      name: "Learning Paths",
      version: "0.1.0",
      minAppVersion: "0.6.0",
    },
    signal: controller.signal,
    cleanup: () => () => {},
    registerView: (view: PluginView) => {
      views.push(view);
      return () => {
        const index = views.indexOf(view);
        if (index >= 0) views.splice(index, 1);
      };
    },
    registerAction: (action: PluginAction) => {
      actions.push(action);
      return () => {
        const index = actions.indexOf(action);
        if (index >= 0) actions.splice(index, 1);
      };
    },
    placeAction: (placement: PluginActionPlacement) => {
      placements.push(placement);
      return () => {
        const index = placements.indexOf(placement);
        if (index >= 0) placements.splice(index, 1);
      };
    },
    refreshActions: () => {},
    registerSubmissionInterceptor: () => () => {},
    refreshSubmissions: () => {},
    registerSettings: (mount: PluginView["mount"]) => {
      settingsMounts.push(mount);
      return () => {
        const index = settingsMounts.indexOf(mount);
        if (index >= 0) settingsMounts.splice(index, 1);
      };
    },
    ui,
    registerCodeBlock: () => () => {},
    registerToolRenderer: (renderer: PluginToolRenderer) => {
      toolRenderers.set(renderer.toolName, renderer);
      return () => {
        if (toolRenderers.get(renderer.toolName) === renderer) toolRenderers.delete(renderer.toolName);
      };
    },
    registerQuestionRenderer: () => () => {},
    registerProblemRenderer: () => () => {},
    call,
    documents: {
      toMarkdown: (file: File, options?: { signal?: AbortSignal }) =>
        fixtures.toMarkdown(file).then((converted) => {
          if (options?.signal?.aborted) throw options.signal.reason;
          return converted;
        }),
    },
    onNotification: (listener: (event: { pluginId: string; topic: string; data?: unknown }) => void) => {
      notificationListeners.push(listener);
      return () => {
        const index = notificationListeners.indexOf(listener);
        if (index >= 0) notificationListeners.splice(index, 1);
      };
    },
    onAppEvent: () => () => {},
    onResync: (listener: () => void) => {
      resyncListeners.push(listener);
      return () => {
        const index = resyncListeners.indexOf(listener);
        if (index >= 0) resyncListeners.splice(index, 1);
      };
    },
    app: {
      pathname: () => "/",
      openSession: (id: string) => {
        openedSessions.push(id);
      },
      openHome: () => {},
      openView: (id: string) => {
        openedViews.push(id);
      },
      openSettings: () => {},
    },
  } as unknown as PluginFrontendContext;

  fixtures = {
    root,
    context,
    controller,
    records,
    calls,
    openedSessions,
    openedViews,
    actions,
    placements,
    toolRenderers,
    views,
    settingsMounts,
    paths,
    settings: settingsState,
    conversations,
    nativeChats,
    uploaded,
    toMarkdown: async (file: File) => ({
      name: file.name,
      markdown: `# ${file.name}\n\nConverted text.`,
      notices: [],
    }),
    find(method, predicate) {
      const found = records.find(
        (record) => !record.disposed && record.method === method && (!predicate || predicate(record)),
      );
      assert.ok(found, `No live ${method} mount`);
      return found;
    },
    findLast(method, predicate) {
      const found = records.findLast(
        (record) => !record.disposed && record.method === method && (!predicate || predicate(record)),
      );
      assert.ok(found, `No live ${method} mount`);
      return found;
    },
    all(method) {
      return records.filter((record) => !record.disposed && record.method === method);
    },
    emit(topic, data) {
      for (const listener of [...notificationListeners]) {
        listener({ pluginId: "learning-path", topic, data });
      }
    },
    resync() {
      for (const listener of [...resyncListeners]) listener();
    },
    async flush() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    restore() {
      controller.abort();
      for (const record of records) record.handle.dispose();
      if (previous) Object.defineProperty(globalThis, "document", previous);
      else Reflect.deleteProperty(globalThis, "document");
    },
  };
  return fixtures;
}

/** Fire a bubbling DOM event without depending on a native event constructor. */
export function fire(element: HTMLElement, type: string): void {
  const event = element.ownerDocument.createEvent("Event");
  event.initEvent(type, true, false);
  element.dispatchEvent(event);
}

export function setSelect(select: HTMLSelectElement, value: string): void {
  // linkedom exposes select.value as a getter only; select the option instead.
  const option = select.querySelector<HTMLOptionElement>(`option[value="${value}"]`);
  assert.ok(option, `No option ${value} in select`);
  for (const candidate of select.options) candidate.selected = false;
  option.selected = true;
  fire(select, "change");
}
