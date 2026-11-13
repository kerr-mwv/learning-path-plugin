/** Path Hub view.
 *
 * One plugin view with four cooperating surfaces:
 * - a header bar with path switcher, Create a Path, Refine Path and progress;
 * - the accessible module → node → child-chat tree (`ctx.ui.mountTree`);
 * - the Architect chat pane (`mountStandardComposer` + `mountMarkdown`);
 * - the Node Inspector (pre-reading, artifact justification, progression).
 *
 * Lifecycle: every widget, listener, timer-free async load and DOM node belongs
 * to the per-mount signal. Stale loads are fenced by a request token, and
 * `onNotification` / `onResync` re-read authoritative state instead of trusting
 * a notification payload as data.
 */
import type {
  PluginFrontendContext,
  PluginTreeProps,
  PluginTreeRow,
  PluginUiContent,
  PluginWidgetHandle,
} from "learnharness-plugin-api";
import type { ArtifactType, ChildSessionKind, LearningPath, PathNode, PivotSuggestion, ProgressionState } from "../domain.ts";
import { createSessionLauncher } from "../session-launcher.ts";
import type { NativeSessionHost } from "../native-session-host.ts";
import { consumePathHubTarget, subscribePathHubTarget } from "../session-navigation.ts";
import type { SessionStatus } from "../session-types.ts";
import {
  ARTIFACT_TYPES,
  PROGRESSION_STATES,
  artifactCatalogEntry,
  recommendedArtifactsFor,
} from "../domain.ts";
import { EVENT_ARCHITECT_CHANGED, EVENT_PATHS_CHANGED } from "../topics.ts";
import { createArchitectPane } from "./architect-pane.ts";
import { openDraftKnowledgeDialog } from "./draft-knowledge-dialog.ts";
import { createNodeInspector } from "./node-inspector.ts";
import type { NodeInspectorChange } from "./node-inspector.ts";
import type { ErrorLedgerChange } from "./error-ledger.ts";
import { pivotDiscussionPrompt } from "./pivot-banner.ts";
import type { PivotDecision } from "./pivot-banner.ts";
import { openLinkExistingSessionDialog } from "./session-dialogs.ts";
import {
  NODE_TYPE_COLORS,
  NODE_TYPE_LABELS,
  PROGRESSION_COLORS,
  PROGRESSION_LABELS,
  artifactLabel,
} from "./labels.ts";

/** The backend's `paths.list` projection; not a second full path payload. */
export interface PathSummary {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly updatedAt: string;
  readonly moduleCount: number;
  readonly nodeCount: number;
  readonly sourceMode: "canonical" | "uploaded";
  readonly architectChatId?: string | null;
}

interface PathsListResult {
  readonly paths: readonly PathSummary[];
}

interface PathResult {
  readonly path: LearningPath | null;
}

interface ContentEntry {
  readonly signature: string;
  readonly content: PluginUiContent;
}

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function nodeById(path: LearningPath, nodeId: string | null): PathNode | null {
  if (!nodeId) return null;
  for (const module of path.modules) {
    const node = module.nodes.find((candidate) => candidate.id === nodeId);
    if (node) return node;
  }
  return null;
}

function countNodes(path: LearningPath): { total: number; consolidated: number; inProgress: number } {
  let total = 0;
  let consolidated = 0;
  let inProgress = 0;
  for (const module of path.modules) {
    for (const node of module.nodes) {
      total += 1;
      if (node.progression === "consolidated") consolidated += 1;
      if (node.progression === "in_progress") inProgress += 1;
    }
  }
  return { total, consolidated, inProgress };
}

/** Mount the Path Hub into a plugin view container and return its cleanup. */
export interface PathHubOptions {
  /** Test seam: inject the native session host so no network/storage is touched. */
  readonly sessionHost?: NativeSessionHost;
}

export function mountPathHub(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: PathHubOptions = {},
): () => void {
  const document = container.ownerDocument;
  const root = element(document, "div", "lp-hub");
  container.append(root);

  const header = element(document, "header", "lp-header");
  const titleBlock = element(document, "div", "lp-title-block");
  const title = element(document, "h1", "lp-title", "Path Hub");
  const goal = element(document, "p", "lp-goal");
  titleBlock.append(title, goal);
  header.append(titleBlock);

  const headerActions = element(document, "div", "lp-header-actions");
  const pathLabel = element(document, "label", "lp-path-field");
  pathLabel.append(element(document, "span", "lp-field-label", "Learning path"));
  const pathSelect = element(document, "select", "lp-select lp-path-select");
  pathSelect.setAttribute("aria-label", "Learning path");
  pathLabel.append(pathSelect);
  headerActions.append(pathLabel);

  const createHost = element(document, "span", "lp-button-host");
  const refineHost = element(document, "span", "lp-button-host");
  const draftKnowledgeHost = element(document, "span", "lp-button-host");
  headerActions.append(createHost, refineHost, draftKnowledgeHost);
  const summary = element(document, "p", "lp-progress-summary");
  summary.setAttribute("aria-live", "polite");
  headerActions.append(summary);
  header.append(headerActions);
  root.append(header);

  const hubError = element(document, "p", "lp-hub-error");
  hubError.setAttribute("role", "alert");
  hubError.hidden = true;
  root.append(hubError);

  const body = element(document, "div", "lp-hub-body");
  const treePane = element(document, "section", "lp-tree-pane");
  treePane.setAttribute("aria-label", "Path hierarchy");
  treePane.append(element(document, "h2", "lp-pane-title", "Path tree"));
  const treeHost = element(document, "div", "lp-tree-host");
  const treeEmpty = element(
    document,
    "p",
    "lp-empty-state",
    "No learning paths yet. Use Create a Path to talk to the Architect.",
  );
  treePane.append(treeHost, treeEmpty);
  const architectContainer = element(document, "div", "lp-architect-pane");
  const inspectorContainer = element(document, "div", "lp-inspector-pane");
  body.append(treePane, architectContainer, inspectorContainer);
  root.append(body);

  let summaries: PathSummary[] = [];
  let path: LearningPath | null = null;
  let selectedPathId: string | null = null;
  let selectedNodeId: string | null = null;
  let refineOpen = false;
  /** Path whose Architect conversation was last opened automatically. Background
   * refreshes for the same path never switch away from the conversation in view. */
  let autoLoadedPathId: string | null = null;
  /** A path the Architect just created; selected if the pane shows its conversation. */
  let createdPathId: string | null = null;
  let loadToken = 0;
  let disposed = false;
  let startingSession = false;
  let treeHandle: PluginWidgetHandle<PluginTreeProps> | null = null;
  const chatStatuses = new Map<string, SessionStatus>();
  const expanded = new Map<string, boolean>();
  const contentCache = new Map<string, ContentEntry>();
  const handles: PluginWidgetHandle<unknown>[] = [];
  handles.push(ctx.ui.mountButton(draftKnowledgeHost, {
    label: "Check draft knowledge", variant: "outline", size: "sm",
    onClick: () => { if (!signal.aborted && !disposed) openDraftKnowledgeDialog(ctx, signal); },
  }, { signal }));

  const pane = createArchitectPane(ctx, architectContainer, signal);
  const launcher = createSessionLauncher(ctx, { host: options.sessionHost });
  const inspector = createNodeInspector(ctx, inspectorContainer, signal, {
    openSession(chatId) {
      if (!signal.aborted && !disposed) ctx.app.openSession(chatId);
    },
    startSession(kind) {
      return startChildSession(kind);
    },
    linkExistingSession() {
      openLinkExisting();
    },
    unlinkSession(chatId) {
      return unlinkSession(chatId);
    },
    chatStatus: chatStatuses,
    selectNode(nodeId) {
      selectNode(nodeId);
    },
    updateNode(change) {
      return updateNode(change);
    },
    updateError(errorId, change) {
      return updateError(errorId, change);
    },
    decidePivot(pivotId, decision) {
      return decidePivot(pivotId, decision);
    },
    discussPivot(pivot, node) {
      return discussPivot(pivot, node);
    },
  });

  const live = (token: number): boolean => !disposed && !signal.aborted && token === loadToken;

  function showError(message: string | null): void {
    if (disposed || signal.aborted) return;
    hubError.textContent = message ?? "";
    hubError.hidden = message === null;
  }

  function expandedFor(key: string, fallback = true): boolean {
    return expanded.get(key) ?? fallback;
  }

  function setExpanded(key: string, value: boolean): void {
    if (disposed || signal.aborted) return;
    expanded.set(key, value);
    renderTree();
  }

  function selectNode(nodeId: string | null): void {
    if (disposed || signal.aborted) return;
    selectedNodeId = nodeId;
    renderInspector();
    renderTree();
  }

  function cachedContent(key: string, signature: string, build: () => PluginUiContent): PluginUiContent {
    const existing = contentCache.get(key);
    if (existing && existing.signature === signature) return existing.content;
    const content = build();
    contentCache.set(key, { signature, content });
    return content;
  }

  function nodeBadges(node: PathNode, signature: string): PluginUiContent {
    return cachedContent(`node:${node.id}`, signature, () => (host, contentSignal) => {
      const row = element(document, "span", "lp-tree-node");
      const labels = element(document, "span", "lp-tree-node-labels");
      const badgeHost = element(document, "span", "lp-badge-row");
      const titles = element(document, "span", "lp-tree-node-title", node.title);
      labels.append(badgeHost, titles);
      row.append(labels);
      const nodeBadge = ctx.ui.mountBadge(
        badgeHost,
        { text: NODE_TYPE_LABELS[node.type], color: NODE_TYPE_COLORS[node.type] },
        { signal: contentSignal },
      );
      const progressionBadge = ctx.ui.mountBadge(
        badgeHost,
        { text: PROGRESSION_LABELS[node.progression], color: PROGRESSION_COLORS[node.progression] },
        { signal: contentSignal },
      );
      const unresolved = node.errors.filter((entry) => !entry.resolved).length;
      const errorBadge =
        unresolved > 0
          ? ctx.ui.mountBadge(
              badgeHost,
              { text: `${unresolved} error${unresolved === 1 ? "" : "s"}`, color: "var(--chart-6, #ef4444)" },
              { signal: contentSignal },
            )
          : null;
      return () => {
        nodeBadge.dispose();
        progressionBadge.dispose();
        errorBadge?.dispose();
        row.remove();
      };
    });
  }

  function chatContent(
    node: PathNode,
    chatId: string,
    label: string,
    kind: string,
    exists: boolean,
  ): PluginUiContent {
    return cachedContent(`chat:${node.id}:${chatId}`, `${label}:${kind}:${exists}`, () => (host, contentSignal) => {
      const row = element(document, "span", "lp-tree-chat");
      row.append(
        element(
          document,
          "span",
          "lp-tree-chat-label",
          `${kind} — ${label}${exists ? "" : " (missing)"}`,
        ),
      );
      const buttonHost = element(document, "span", "lp-button-host");
      row.append(buttonHost);
      const open = exists
        ? ctx.ui.mountButton(
            buttonHost,
            {
              label: "Open",
              variant: "link",
              size: "xs",
              onClick: () => {
                if (!signal.aborted && !contentSignal.aborted && !disposed) {
                  ctx.app.openSession(chatId);
                }
              },
            },
            { signal: contentSignal },
          )
        : null;
      host.append(row);
      return () => {
        open?.dispose();
        row.remove();
      };
    });
  }

  function nodeRow(node: PathNode): PluginTreeRow {
    const key = `node:${node.id}`;
    const signature = `${node.title}\u0000${node.type}\u0000${node.progression}\u0000${node.errors.filter((entry) => !entry.resolved).length}`;
    const unresolved = node.errors.filter((entry) => !entry.resolved).length;
    const children = node.childSessions.map((chat) => {
      const exists = chatStatuses.get(chat.chatId)?.exists ?? true;
      return {
        key: `chat:${node.id}:${chat.chatId}`,
        content: chatContent(
          node,
          chat.chatId,
          chat.label,
          chat.kind === "teaching" ? "Teaching" : "Practice",
          exists,
        ),
        cells: { state: chat.kind === "teaching" ? "Teaching" : "Practice" },
      };
    });
    return {
      key,
      content: nodeBadges(node, signature),
      cells: { state: unresolved > 0 ? `${unresolved} unresolved` : PROGRESSION_LABELS[node.progression] },
      ...(children.length > 0
        ? {
            children,
            disclosure: {
              label: `Toggle child chats for ${node.title}`,
              expanded: expandedFor(key),
              onChange: (value: boolean) => setExpanded(key, value),
            },
          }
        : {}),
      selection: {
        label: `Select ${node.title}`,
        checked: selectedNodeId === node.id,
        onChange: (value: boolean) => {
          if (signal.aborted) return;
          selectNode(value ? node.id : selectedNodeId === node.id ? null : selectedNodeId);
        },
      },
    };
  }

  function treeRows(): PluginTreeRow[] {
    if (!path) return [];
    return path.modules.map((module) => {
      const key = `module:${module.id}`;
      const consolidated = module.nodes.filter((node) => node.progression === "consolidated").length;
      return {
        key,
        content: module.title,
        cells: { state: `${consolidated}/${module.nodes.length} consolidated` },
        disclosure: {
          label: `Toggle ${module.title}`,
          expanded: expandedFor(key),
          onChange: (value: boolean) => setExpanded(key, value),
        },
        children: module.nodes.map(nodeRow),
      };
    });
  }

  function renderTree(): void {
    if (disposed || signal.aborted) return;
    treeEmpty.hidden = path !== null;
    treeHost.hidden = path === null;
    if (!path) return;
    const props: PluginTreeProps = {
      label: "Path hierarchy",
      header: "Path",
      rows: treeRows(),
      columns: [{ key: "state", header: "State", width: 136 }],
    };
    if (!treeHandle) {
      treeHandle = ctx.ui.mountTree(treeHost, props, { signal });
    } else {
      treeHandle.update(props);
    }
  }

  function renderInspector(): void {
    if (disposed || signal.aborted) return;
    const node = path ? nodeById(path, selectedNodeId) : null;
    inspector.render(path, node);
  }

  function renderHeader(): void {
    if (disposed || signal.aborted) return;
    pathSelect.replaceChildren();
    for (const summaryItem of summaries) {
      const option = element(document, "option", undefined, summaryItem.title);
      option.value = summaryItem.id;
      if (summaryItem.id === selectedPathId) option.selected = true;
      pathSelect.append(option);
    }
    pathSelect.disabled = summaries.length === 0;

    goal.textContent = path?.goal ?? "Create a path, then follow its modules, nodes and child chats.";

    if (path) {
      const { total, consolidated, inProgress } = countNodes(path);
      summary.textContent = `${consolidated} of ${total} nodes consolidated · ${inProgress} in progress`;
      summary.dataset.total = String(total);
      summary.dataset.consolidated = String(consolidated);
      summary.dataset.inProgress = String(inProgress);
    } else {
      summary.textContent = "No path selected";
      delete summary.dataset.total;
      delete summary.dataset.consolidated;
      delete summary.dataset.inProgress;
    }

    createButton.update({ disabled: false });
    refineButton.update({
      label: refineOpen ? "Refine Path · on" : "Refine Path",
      variant: refineOpen ? "secondary" : "outline",
    });
    // Keep the Architect visible while there is no path yet: that is how one is made.
    architectContainer.hidden = !refineOpen && summaries.length > 0;
  }

  function renderAll(): void {
    if (disposed || signal.aborted) return;
    renderHeader();
    renderTree();
    renderInspector();
  }

  function ensureSelection(): void {
    if (!path) {
      selectedNodeId = null;
      return;
    }
    if (!nodeById(path, selectedNodeId)) {
      selectedNodeId = path.modules[0]?.nodes[0]?.id ?? null;
    }
  }

  async function refreshChatStatuses(token: number, pathId: string): Promise<void> {
    if (disposed || signal.aborted) return;
    try {
      const result = await ctx.call<{ sessions: readonly SessionStatus[] }>(
        "sessions.status",
        { pathId },
      );
      if (!live(token)) return;
      chatStatuses.clear();
      for (const session of result.sessions ?? []) chatStatuses.set(session.chatId, session);
    } catch {
      // Missing status is not fatal: links still render, and tools re-check existence.
      if (live(token)) chatStatuses.clear();
    }
  }

  async function refreshAll(): Promise<void> {
    if (disposed || signal.aborted) return;
    const token = ++loadToken;
    // A top-bar navigation may have arrived before this mount finished loading.
    const target = consumePathHubTarget();
    if (target) {
      selectedPathId = target.pathId;
      selectedNodeId = target.nodeId;
    }
    try {
      const listed = await ctx.call<PathsListResult>("paths.list");
      if (!live(token)) return;
      summaries = [...(listed.paths ?? [])];
      if (createdPathId) {
        const created = summaries.find((entry) => entry.id === createdPathId);
        createdPathId = null;
        if (created?.architectChatId && created.architectChatId === pane.conversationId()) {
          selectedPathId = created.id;
          selectedNodeId = null;
        }
      }
      if (!selectedPathId || !summaries.some((entry) => entry.id === selectedPathId)) {
        selectedPathId = summaries[0]?.id ?? null;
        if (target) selectedNodeId = null;
      }
      let loaded: LearningPath | null = null;
      if (selectedPathId) {
        const result = await ctx.call<PathResult>("paths.get", { id: selectedPathId });
        if (!live(token)) return;
        loaded = result.path;
      }
      path = loaded;
      if (path) {
        await refreshChatStatuses(token, path.id);
        if (!live(token)) return;
      } else {
        chatStatuses.clear();
      }
      ensureSelection();
      showError(null);
      renderAll();

      if (path?.architectChatId && !pane.isNewDraft() && path.id !== autoLoadedPathId) {
        autoLoadedPathId = path.id;
        if (pane.conversationId() !== path.architectChatId) {
          await pane.load(path.architectChatId);
        }
      }
    } catch (problem) {
      if (!live(token)) return;
      showError(`Could not load learning paths: ${problem instanceof Error ? problem.message : String(problem)}`);
    }
  }

  async function selectPath(pathId: string): Promise<void> {
    if (disposed || signal.aborted || pathId === selectedPathId) return;
    selectedPathId = pathId;
    selectedNodeId = null;
    await refreshAll();
    // An explicit path selection takes precedence over an unsent new-path draft.
    if (path?.id === pathId && path.architectChatId && pane.isNewDraft()) {
      autoLoadedPathId = path.id;
      await pane.load(path.architectChatId);
    }
  }

  async function updateNode(change: NodeInspectorChange): Promise<void> {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    try {
      const result = await ctx.call<PathResult & { path: LearningPath }>("paths.updateNode", {
        pathId: path.id,
        nodeId: selectedNodeId,
        ...change,
      });
      if (disposed || signal.aborted) return;
      path = result.path;
      ensureSelection();
      showError(null);
      renderAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(`Could not save the node change: ${problem instanceof Error ? problem.message : String(problem)}`);
    }
  }

  async function updateError(errorId: string, change: ErrorLedgerChange): Promise<void> {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    try {
      const result = await ctx.call<PathResult & { path: LearningPath }>("errors.update", {
        pathId: path.id,
        nodeId: selectedNodeId,
        errorId,
        ...change,
      });
      if (disposed || signal.aborted) return;
      path = result.path;
      ensureSelection();
      showError(null);
      renderAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(
        `Could not update the error ledger: ${problem instanceof Error ? problem.message : String(problem)}`,
      );
    }
  }

  async function decidePivot(pivotId: string, decision: PivotDecision): Promise<void> {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    try {
      const result = await ctx.call<{
        path: LearningPath;
        insertedNode: PathNode | null;
        changed: boolean;
      }>("pivots.resolve", {
        pathId: path.id,
        nodeId: selectedNodeId,
        pivotId,
        action: decision,
      });
      if (disposed || signal.aborted) return;
      path = result.path;
      if (decision === "accept" && result.insertedNode) {
        // Show the inserted repair node so its anchor and goal are visible.
        selectedNodeId = result.insertedNode.id;
      }
      ensureSelection();
      showError(null);
      renderAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(
        `Could not ${decision} the pivot: ${problem instanceof Error ? problem.message : String(problem)}`,
      );
    }
  }

  async function discussPivot(pivot: PivotSuggestion, node: PathNode): Promise<void> {
    if (disposed || signal.aborted) return;
    refineOpen = true;
    renderHeader();
    // A pivot belongs to this path: discuss it in the path's own Architect
    // conversation, not in an unsent new-path draft or another path's chat.
    if (path?.architectChatId && pane.conversationId() !== path.architectChatId) {
      await pane.load(path.architectChatId);
      if (disposed || signal.aborted) return;
    }
    await pane.discuss(pivotDiscussionPrompt(pivot, node));
  }

  async function startChildSession(kind: ChildSessionKind): Promise<void> {
    if (disposed || signal.aborted || startingSession || !path || !selectedNodeId) return;
    startingSession = true;
    try {
      await launcher.start({ pathId: path.id, nodeId: selectedNodeId, kind });
      if (disposed || signal.aborted) return;
      await refreshAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(
        `Could not start the ${kind} chat: ${problem instanceof Error ? problem.message : String(problem)}`,
      );
    } finally {
      startingSession = false;
    }
  }

  function openLinkExisting(): void {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    const node = nodeById(path, selectedNodeId);
    if (!node) return;
    openLinkExistingSessionDialog(ctx, {
      launcher,
      pathId: path.id,
      nodeId: node.id,
      nodeTitle: node.title,
      signal,
      onLinked() {
        void refreshAll();
      },
    });
  }

  async function unlinkSession(chatId: string): Promise<void> {
    if (disposed || signal.aborted || !path || !selectedNodeId) return;
    try {
      const result = await ctx.call<{ path: LearningPath }>("sessions.unlink", {
        pathId: path.id,
        nodeId: selectedNodeId,
        chatId,
      });
      if (disposed || signal.aborted) return;
      path = result.path;
      await refreshChatStatuses(loadToken, path.id);
      if (disposed || signal.aborted) return;
      showError(null);
      renderAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(
        `Could not unlink the chat: ${problem instanceof Error ? problem.message : String(problem)}`,
      );
    }
  }

  const createButton = ctx.ui.mountButton(
    createHost,
    {
      label: "Create a Path",
      variant: "default",
      size: "sm",
      onClick: () => {
        if (signal.aborted || disposed) return;
        refineOpen = true;
        renderHeader();
        pane.startNew();
      },
    },
    { signal },
  );
  handles.push(createButton);

  const refineButton = ctx.ui.mountButton(
    refineHost,
    {
      label: "Refine Path",
      variant: "outline",
      size: "sm",
      onClick: () => {
        if (signal.aborted || disposed) return;
        refineOpen = !refineOpen;
        renderHeader();
        if (!refineOpen) return;
        // Refine Path always means the selected path's conversation, even over an unsent draft.
        if (path?.architectChatId) {
          if (pane.conversationId() !== path.architectChatId) void pane.load(path.architectChatId);
        } else if (!pane.conversationId()) {
          pane.startNew();
        }
      },
    },
    { signal },
  );
  handles.push(refineButton);

  pathSelect.addEventListener("change", () => {
    if (signal.aborted || disposed) return;
    void selectPath(pathSelect.value);
  });

  const offNotification = ctx.onNotification((event) => {
    if (signal.aborted || disposed) return;
    if (event.topic === EVENT_PATHS_CHANGED) {
      const data = event.data as { id?: unknown; created?: unknown; knowledgeChanged?: unknown } | undefined;
      // Knowledge panels own these refreshes. Rebuilding the inspector here
      // would discard other candidates and unsaved learner review choices.
      if (data?.knowledgeChanged === true) return;
      if (data?.created === true && typeof data.id === "string") createdPathId = data.id;
      void refreshAll();
      return;
    }
    if (event.topic === EVENT_ARCHITECT_CHANGED) {
      const data = event.data as { id?: unknown; messageCount?: unknown } | undefined;
      const id = typeof data?.id === "string" ? data.id : null;
      const messageCount = typeof data?.messageCount === "number" ? data.messageCount : undefined;
      if (id && id === pane.conversationId()) void pane.refresh(id, messageCount);
    }
  });

  const offNavigation = subscribePathHubTarget((target) => {
    if (signal.aborted || disposed) return;
    consumePathHubTarget();
    if (path?.id === target.pathId) {
      selectedPathId = target.pathId;
      selectedNodeId = target.nodeId;
      renderAll();
      return;
    }
    selectedPathId = target.pathId;
    selectedNodeId = target.nodeId;
    void refreshAll();
  });

  const offResync = ctx.onResync(() => {
    if (signal.aborted || disposed) return;
    void refreshAll();
    const id = pane.conversationId();
    if (id) void pane.load(id);
  });

  const onAbort = (): void => {
    if (disposed) return;
    disposed = true;
    loadToken += 1;
    offNotification();
    offNavigation();
    offResync();
    for (const handle of handles.reverse()) handle.dispose();
    handles.length = 0;
    treeHandle?.dispose();
    treeHandle = null;
    inspector.dispose();
    pane.dispose();
    contentCache.clear();
    root.remove();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  void refreshAll();

  return () => {
    signal.removeEventListener("abort", onAbort);
    onAbort();
  };
}

/** Exported for the inspector and tests: every artifact the UI can persist. */
export const PATH_HUB_ARTIFACTS: readonly ArtifactType[] = ARTIFACT_TYPES;

/** Exported for tests and future slices: the three ungated progression states. */
export const PATH_HUB_PROGRESSIONS: readonly ProgressionState[] = PROGRESSION_STATES;

/** Human-readable artifact label (kept beside the tree so both panes agree). */
export function describeArtifact(type: ArtifactType): string {
  return `${artifactLabel(type)}: ${artifactCatalogEntry(type).justification}`;
}

/** The framework's first recommendation for a node type, for inline hints. */
export function firstRecommendedArtifact(node: PathNode): ArtifactType {
  return recommendedArtifactsFor(node.type)[0] ?? "none";
}
