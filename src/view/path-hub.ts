/** Path Hub view.
 *
 * One plugin view with four cooperating surfaces:
 * - a header bar with path switcher, Create a Path, Refine Path and progress;
 * - the path pane: the module-lane roadmap (one lane per module, node cards,
 *   no arrows, dates or order pressure);
 * - the Architect chat pane (`mountStandardComposer` + `mountMarkdown`);
 * - the Node Inspector (pre-reading, artifact justification, progression and
 *   child-chat actions).
 *
 * Lifecycle: every widget, listener, timer-free async load and DOM node belongs
 * to the per-mount signal. Stale loads are fenced by a request token, and
 * `onNotification` / `onResync` re-read authoritative state instead of trusting
 * a notification payload as data.
 */
import type {
  PluginFrontendContext,
  PluginWidgetHandle,
} from "learnharness-plugin-api";
import type { ArtifactType, ChildSessionKind, LearningPath, PathNode, PivotSuggestion, ProgressionState, WorkspaceManifest } from "../domain.ts";
import { triggerBrowserDownload } from "../export.ts";
import type { ExportedLearningPath, ExportFormat } from "../export.ts";
import { createSessionLauncher } from "../session-launcher.ts";
import type { NativeSessionHost } from "../native-session-host.ts";
import { consumePathHubTarget, subscribePathHubTarget } from "../session-navigation.ts";
import type { SessionStatus } from "../session-types.ts";
import {
  ARTIFACT_TYPES,
  PROGRESSION_STATES,
  artifactCatalogEntry,
  formatSourceAnchor,
  recommendedArtifactsFor,
} from "../domain.ts";
import { EVENT_ARCHITECT_CHANGED, EVENT_PATHS_CHANGED, EVENT_WORKSPACE_CHANGED } from "../topics.ts";
import { createArchitectPane } from "./architect-pane.ts";
import { createPathsOverview } from "./paths-overview.ts";
import { createNodeInspector } from "./node-inspector.ts";
import type { NodeInspectorChange } from "./node-inspector.ts";
import type { ErrorLedgerChange } from "./error-ledger.ts";
import { pivotDiscussionPrompt } from "./pivot-banner.ts";
import type { PivotDecision } from "./pivot-banner.ts";
import { openLinkExistingSessionDialog } from "./session-dialogs.ts";
import { createWorkspacePane } from "./workspace-pane.ts";
import type { AddNoteInput, AddSourceInput } from "./workspace-pane.ts";
import type { WorkspaceItemLink } from "../domain.ts";
import {
  NODE_TYPE_COLORS,
  NODE_TYPE_LABELS,
  PROGRESSION_COLORS,
  PROGRESSION_LABELS,
  artifactLabel,
} from "./labels.ts";

/** The backend's `paths.list` projection; not a second full path payload.
 * Mirrored by the backend's own `summarize` and the test host: keep all three
 * in sync when a field is added. */
export interface PathSummary {
  readonly id: string;
  readonly title: string;
  readonly goal: string;
  readonly updatedAt: string;
  readonly moduleCount: number;
  readonly nodeCount: number;
  readonly sourceMode: "canonical" | "uploaded";
  /** Spine titles for the overview card: canonical references or uploads. */
  readonly sourceTitles: readonly string[];
  /** Ungated node-state inventory: honest counts, never a completion target. */
  readonly nodeStates: Readonly<Record<ProgressionState, number>>;
  readonly pendingPivotCount: number;
  readonly unresolvedErrorCount: number;
  /** Learner-owned grouping tags; absent on old paths reads as none. */
  readonly tags: readonly string[];
  /** The path's one folder home, or null when unfiled. */
  readonly folder: string | null;
  readonly architectChatId?: string | null;
}

interface PathsListResult {
  readonly paths: readonly PathSummary[];
}

interface PathResult {
  readonly path: LearningPath | null;
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

/** Trusted SVG markup for the window bar's icon-only host buttons (24×24
 * lucide-style line art, matching the ledger's kind icons). The label stays
 * the accessible name and the title the hover tooltip, so the bar reads at a
 * glance without hiding anything from hover or a screen reader. */
const windowIcon = (paths: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** Expand: arrows pointing to the four corners. */
const EXPAND_ICON = windowIcon(
  '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
);
/** Restore: arrows pointing inward to the edges' midpoints. */
const RESTORE_ICON = windowIcon(
  '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
);
/** Close: an X. */
const CLOSE_ICON = windowIcon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>');

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
  /** Test seam: observe or replace the browser download for an export. */
  readonly onExport?: (exported: ExportedLearningPath) => void;
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
  const exportHost = element(document, "span", "lp-button-host");
  headerActions.append(createHost, refineHost, exportHost);
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
  const overviewContainer = element(document, "section", "lp-overview-pane");
  overviewContainer.setAttribute("aria-label", "Paths overview");
  root.append(overviewContainer);
  // The host tree widget is gone: this pane holds the module-lane roadmap, the
  // one lens over the recorded structure.
  const pathPane = element(document, "section", "lp-path-pane");
  pathPane.setAttribute("aria-label", "Path roadmap");
  const paneTitle = element(document, "h2", "lp-pane-title", "Path roadmap");
  pathPane.append(paneTitle);
  const roadmapHost = element(document, "div", "lp-roadmap-host");
  roadmapHost.hidden = true;
  const pathEmpty = element(
    document,
    "p",
    "lp-empty-state",
    "No learning paths yet. Use Create a Path to talk to the Architect.",
  );
  pathPane.append(roadmapHost, pathEmpty);
  const architectContainer = element(document, "div", "lp-architect-pane");
  body.append(pathPane, architectContainer);
  root.append(body);

  // The detailed view floats over the hub's right half, pinned to the top
  // of the learner's viewport: the roadmap and the Architect conversation keep
  // their width, and the inspector opens on node selection and closes on demand.
  // The frame itself never scrolls: an inner scroller owns the overflow (so the
  // title bar can auto-hide out of the way while scrolling down and come back
  // on the way up). Dragging the bar moves the whole window (vertically and
  // horizontally) away from its pinned spot; a drag grip on the left edge
  // resizes it; an Expand toggle stretches it across the whole hub.
  // One floating window, two tabs: the node details and the workspace ledger
  // get exactly the same treatment — the window pins under the header, the
  // drag grip resizes it, Expand stretches either tab across the hub, Close
  // dismisses it. The ledger is a tab of the window the learner already
  // works in, never a separate pane stacked underneath the details.
  const inspectorContainer = element(document, "aside", "lp-inspector-pane");
  inspectorContainer.setAttribute("aria-label", "Node details and workspace");
  inspectorContainer.hidden = true;
  const inspectorGrip = element(document, "div", "lp-inspector-grip");
  inspectorGrip.setAttribute("aria-hidden", "true");
  inspectorGrip.title = "Drag to resize · double-click to reset";
  const inspectorScroll = element(document, "div", "lp-inspector-scroll");
  const inspectorBar = element(document, "div", "lp-inspector-bar");
  const inspectorTabs = element(document, "div", "lp-inspector-tabs");
  const tabButton = (pressed: boolean, onClick: () => void): HTMLButtonElement => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "lp-tab";
    tab.setAttribute("aria-pressed", pressed ? "true" : "false");
    tab.addEventListener("click", () => {
      if (!signal.aborted && !disposed) onClick();
    });
    return tab;
  };
  const detailsTab = tabButton(true, () => selectInspectorTab("details"));
  detailsTab.textContent = "Node details";
  const workspaceTab = tabButton(false, () => selectInspectorTab("workspace"));
  // renderInspector carries the honest item count in the tab's own label.
  workspaceTab.textContent = "Workspace ledger";
  inspectorTabs.append(detailsTab, workspaceTab);
  const inspectorBarActions = element(document, "span", "lp-inspector-bar-actions");
  const inspectorExpandHost = element(document, "span", "lp-button-host");
  const inspectorCloseHost = element(document, "span", "lp-button-host");
  inspectorBarActions.append(inspectorExpandHost, inspectorCloseHost);
  inspectorBar.append(inspectorTabs, inspectorBarActions);
  inspectorScroll.append(inspectorBar);
  // Tab contents share the window's scroller; exactly one is visible.
  const inspectorDetails = element(document, "div", "lp-inspector-content");
  const workspaceBody = element(document, "div", "lp-workspace-body");
  workspaceBody.hidden = true;
  inspectorScroll.append(inspectorDetails, workspaceBody);
  inspectorContainer.append(inspectorGrip, inspectorScroll);
  root.append(inspectorContainer);

  let summaries: PathSummary[] = [];
  let path: LearningPath | null = null;
  /** The selected path's workspace manifest, or null before the first item. */
  let workspace: WorkspaceManifest | null = null;
  let selectedPathId: string | null = null;
  let selectedNodeId: string | null = null;
  /** Window shape the learner controls: Expand stretches the window across
   * the whole hub, and a dragged width (null = the measured default half)
   * survives re-renders and background refreshes. */
  let inspectorExpanded = false;
  let inspectorWidth: number | null = null;
  /** The learner dragged the window off its pinned spot (px offsets from the
   * measured default); null until the first bar drag, and a double-click on
   * the bar resets it. The offset survives refreshes and re-pinning. */
  let inspectorOffset: { x: number; y: number } | null = null;
  /** Last inspector scroll offset and node: scrolling down fades the title bar
   * out of the way, and switching nodes rewinds to the top with it visible. */
  let inspectorScrollTop = 0;
  let lastInspectorNodeId: string | null = null;
  /** The learner closed the detailed view; refreshes keep it closed. */
  let nodeDeselected = false;
  /** Which tab of the floating window is in view. The ledger tab survives
   * refreshes and node switches (the ledger is for the path, not one node);
   * a closed window or a new path resets to the details tab. */
  let inspectorTab: "details" | "workspace" = "details";
  let refineOpen = false;
  /** Path whose Architect conversation was last opened automatically. Background
   * refreshes for the same path never switch away from the conversation in view. */
  let autoLoadedPathId: string | null = null;
  /** A path the Architect just created; selected if the pane shows its conversation. */
  let createdPathId: string | null = null;
  let loadToken = 0;
  let disposed = false;
  let startingSession = false;
  /** Badge handles owned by the current roadmap render; cleared per render. */
  let cardHandles: PluginWidgetHandle<unknown>[] = [];
  const chatStatuses = new Map<string, SessionStatus>();
  const handles: PluginWidgetHandle<unknown>[] = [];

  const pane = createArchitectPane(ctx, architectContainer, signal, {
    // A workspace upload files into the selected path's workspace, linked to
    // the node in view; without a selection the pane declines with a message.
    uploadTarget: () => (path === null ? null : { path, nodeId: selectedNodeId }),
  });
  const launcher = createSessionLauncher(ctx, { host: options.sessionHost });
  const inspector = createNodeInspector(ctx, inspectorDetails, signal, {
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

  const workspacePane = createWorkspacePane(ctx, workspaceBody, signal, {
    saveNote(input) {
      return saveWorkspaceNote(input);
    },
    saveSource(input) {
      return saveWorkspaceSource(input);
    },
    setItemLinks(itemId, links) {
      return setWorkspaceItemLinks(itemId, links);
    },
    deleteItem(itemId) {
      return deleteWorkspaceItem(itemId);
    },
    readItem(itemId) {
      return readWorkspaceItem(itemId);
    },
    openDirectory() {
      if (!signal.aborted && !disposed && path) void openWorkspaceDirectory(path.id);
    },
    openItem(itemId) {
      if (!signal.aborted && !disposed && path) void openWorkspaceItem(path.id, itemId);
    },
  });

  const overview = createPathsOverview(ctx, overviewContainer, signal, {
    selectPath(pathId) {
      if (pathId !== selectedPathId) void selectPath(pathId);
    },
    tagsChanged() {
      void refreshAll();
    },
    pathsChanged() {
      // A deleted path may be the selected one: the ordinary refetch falls
      // back to the first remaining path (or none), exactly like every
      // other paths-changed event.
      void refreshAll();
    },
  });

  const live = (token: number): boolean => !disposed && !signal.aborted && token === loadToken;

  function showError(message: string | null): void {
    if (disposed || signal.aborted) return;
    hubError.textContent = message ?? "";
    hubError.hidden = message === null;
  }

  /** Paint selection on the existing cards instead of rebuilding the view, so
   * a keyboard-triggered selection keeps focus on its card. */
  function applySelection(): void {
    for (const card of root.querySelectorAll<HTMLElement>(".lp-node-card")) {
      const isSelected = selectedNodeId !== null && card.dataset.nodeId === selectedNodeId;
      card.classList.toggle("lp-node-card-selected", isSelected);
      card.classList.toggle("lp-roadmap-card-selected", isSelected);
      card.setAttribute("aria-pressed", isSelected ? "true" : "false");
    }
  }

  function selectNode(nodeId: string | null): void {
    if (disposed || signal.aborted) return;
    selectedNodeId = nodeId;
    // Closing the detailed view is an explicit learner choice: background
    // refreshes must not silently reselect a node and reopen the window.
    nodeDeselected = nodeId === null;
    // A closed window resets to the details tab: reopening never surprises.
    if (nodeId === null) inspectorTab = "details";
    applySelection();
    renderInspector();
  }

  /** Dispose every card badge and the roadmap host. Called on each render and
   * on mount teardown, so no badge handle or DOM outlives the data it showed. */
  function disposeCards(): void {
    for (const handle of cardHandles.reverse()) handle.dispose();
    cardHandles = [];
    roadmapHost.replaceChildren();
  }

  /** One card pattern for the lanes: real button, badges, anchor, selection. */
  function nodeCard(node: PathNode): HTMLElement {
    const card = document.createElement("button");
    card.setAttribute("type", "button");
    card.dataset.nodeId = node.id;
    const selected = node.id === selectedNodeId;
    const classes = ["lp-node-card", "lp-roadmap-card"];
    if (selected) {
      classes.push("lp-node-card-selected", "lp-roadmap-card-selected");
    }
    card.className = classes.join(" ");
    card.setAttribute("aria-pressed", selected ? "true" : "false");
    card.append(element(document, "span", "lp-node-card-title", node.title));
    const badges = element(document, "span", "lp-badge-row lp-node-card-badges");
    card.append(badges);
    cardHandles.push(
      ctx.ui.mountBadge(
        badges,
        { text: NODE_TYPE_LABELS[node.type], color: NODE_TYPE_COLORS[node.type] },
        { signal },
      ),
    );
    cardHandles.push(
      ctx.ui.mountBadge(
        badges,
        { text: PROGRESSION_LABELS[node.progression], color: PROGRESSION_COLORS[node.progression] },
        { signal },
      ),
    );
    const unresolved = node.errors.filter((entry) => !entry.resolved).length;
    if (unresolved > 0) {
      cardHandles.push(
        ctx.ui.mountBadge(
          badges,
          { text: `${unresolved} unresolved`, color: "var(--chart-6, #ef4444)" },
          { signal },
        ),
      );
    }
    card.append(
      element(document, "span", "lp-node-card-anchor", formatSourceAnchor(node.sourceAnchor)),
    );
    if (node.childSessions.length > 0) {
      const teaching = node.childSessions.filter((chat) => chat.kind === "teaching").length;
      const practice = node.childSessions.length - teaching;
      const parts: string[] = [];
      if (teaching > 0) parts.push(`${teaching} teaching`);
      if (practice > 0) parts.push(`${practice} practice`);
      card.append(element(document, "span", "lp-muted", parts.join(" · ")));
    }
    card.addEventListener("click", () => {
      if (signal.aborted || disposed) return;
      selectNode(node.id);
    });
    return card;
  }

  /** Module lanes with node cards: the one flat lens over the recorded
   * structure. No arrows, no dates, no order pressure. */
  function buildRoadmap(): void {
    if (!path) return;
    const board = element(document, "div", "lp-roadmap");
    for (const module of path.modules) {
      const lane = element(document, "section", "lp-lane");
      lane.setAttribute("aria-label", module.title);
      // Compact header: the module goal belongs in the detailed view, not here.
      const laneHeader = element(document, "div", "lp-lane-header");
      laneHeader.append(element(document, "h3", "lp-lane-title", module.title));
      const consolidated = module.nodes.filter((node) => node.progression === "consolidated").length;
      laneHeader.append(
        element(document, "span", "lp-muted", `${consolidated}/${module.nodes.length} consolidated`),
      );
      lane.append(laneHeader);
      const cards = element(document, "div", "lp-lane-cards");
      for (const node of module.nodes) {
        cards.append(nodeCard(node));
      }
      lane.append(cards);
      board.append(lane);
    }
    roadmapHost.append(board);
  }

  function renderPathView(): void {
    if (disposed || signal.aborted) return;
    paneTitle.textContent = "Path roadmap";
    pathPane.setAttribute("aria-label", "Path roadmap");
    pathEmpty.hidden = path !== null;
    roadmapHost.hidden = path === null;
    disposeCards();
    if (path === null) return;
    buildRoadmap();
  }

  /** Breathing room between the window's top pin and whatever it pins under
   * (our own header, the host's stuck view header, the viewport edge). */
  const INSPECTOR_MARGIN = 12;

  /** The host's own view chrome — the header carrying the plugin's name that
   * stays visible while the view scrolls — is not ours to know by selector,
   * and it need not be sticky at all: hosts may keep a static header standing
   * above a scrolling region (LearnHarness's plugin view is one), so the
   * scrolling itself never moves it. Walk up from our root and take the top
   * edge of the nearest scrollable ancestor — the header's standing edge in
   * such hosts, and the viewport top (0) wherever the page itself scrolls.
   * Hosts without layout (the test DOMs) read as 0. */
  function scrollViewportTop(): number {
    const view = document.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") return 0;
    let node: Element | null = root;
    while (node) {
      let overflowY: string;
      try {
        overflowY = view.getComputedStyle(node).overflowY;
      } catch {
        return 0;
      }
      if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
        return node.getBoundingClientRect().top;
      }
      node = node.parentElement;
    }
    return 0;
  }

  /** The host's *stuck* chrome, for hosts that pin their header over the
   * scrolling content instead of beside it: walk up from our root and take
   * the bottom edge of any fixed or stuck element that spans our width along
   * the viewport's very top row; nothing found reads as 0. */
  function hostStuckChromeBottom(): number {
    const view = document.defaultView;
    if (!view || typeof view.getComputedStyle !== "function") return 0;
    const rootRect = root.getBoundingClientRect();
    let bottom = 0;
    const consider = (candidate: Element): void => {
      let position: string;
      try {
        position = view.getComputedStyle(candidate).position;
      } catch {
        return;
      }
      if (position !== "fixed" && position !== "sticky") return;
      const bounds = candidate.getBoundingClientRect();
      // Only chrome that is actually stuck counts: it hugs the viewport's top
      // row and spans our width. An unstuck sticky element (still in flow,
      // mid-page) is skipped, as is chrome beside us — though a root we could
      // not measure (zero-rect hosts) never excludes a candidate.
      if (bounds.top > 1 || bounds.bottom <= 0 || bounds.width === 0) return;
      if (rootRect.width !== 0 && (bounds.right <= rootRect.left || bounds.left >= rootRect.right)) return;
      if (bounds.bottom > bottom) bottom = bounds.bottom;
    };
    let node: Element | null = root;
    while (node) {
      consider(node);
      for (const sibling of node.parentElement?.children ?? []) {
        if (sibling === node) break;
        consider(sibling);
      }
      node = node.parentElement;
    }
    return bottom;
  }

  /** The viewport-top pin the window never tucks under on a scroll: below
   * our own header while it is on screen, below the host's standing view
   * chrome wherever the scroll has moved ours away, and never above the
   * breathing margin. */
  function pinnedTopUnderHeaders(): number {
    return Math.max(
      INSPECTOR_MARGIN,
      header.getBoundingClientRect().bottom + INSPECTOR_MARGIN,
      hostStuckChromeBottom() + INSPECTOR_MARGIN,
      scrollViewportTop() + INSPECTOR_MARGIN,
    );
  }

  /** Pin the floating window to the top of the learner's viewport, not the top
   * of the page: while the header is on screen the window hangs under it, and
   * once the view scrolls it stays below the host's standing view chrome (its
   * header rides above the plugin's scrolling region) instead of jumping to the
   * viewport top. Left and width come from the hub's measured rect so the
   * window keeps floating over the hub's right half wherever the view is
   * scrolled. Expand fills the whole window too — the bottom edge is pinned
   * while the top edge keeps the same measured pin, so the scroller and the
   * ledger in it grow to the full height and the window's own bar never tucks
   * under any header. Zero rects (jsdom, unattached hosts) leave the CSS
   * fallbacks in charge instead of collapsing the pane. */
  function positionInspector(): void {
    const view = document.defaultView;
    if (!view) return;
    // Expanded covers everything: the class pins the bottom edge, and the top
    // edge keeps the same measured pin — a dragged offset stands down.
    if (inspectorExpanded) {
      inspectorContainer.style.top = `${pinnedTopUnderHeaders()}px`;
      const hubRect = root.getBoundingClientRect();
      if (hubRect.width === 0) return;
      inspectorContainer.style.width = `${hubRect.width}px`;
      inspectorContainer.style.left = `${hubRect.right - hubRect.width}px`;
      return;
    }
    const pinnedTop = pinnedTopUnderHeaders();
    inspectorContainer.style.top = `${pinnedTop + (inspectorOffset?.y ?? 0)}px`;
    const hubRect = root.getBoundingClientRect();
    if (hubRect.width === 0) return;
    const width = Math.max(Math.min(inspectorWidth ?? hubRect.width / 2 - 10, hubRect.width), 0);
    inspectorContainer.style.width = `${width}px`;
    inspectorContainer.style.left = `${hubRect.right - width + (inspectorOffset?.x ?? 0)}px`;
  }

  function toggleInspectorExpanded(next: boolean): void {
    inspectorExpanded = next;
    inspectorContainer.classList.toggle("lp-inspector-expanded", next);
    inspectorExpandButton.update(
      next
        ? { label: "Restore", title: "Return the window to its half-pane width", icon: RESTORE_ICON }
        : { label: "Expand", title: "Stretch the window across the hub", icon: EXPAND_ICON },
    );
    positionInspector();
  }

  // The title bar rides at the top of the details, but it must not squat over
  // the content: scrolling down fades it out of the way, and scrolling up (or
  // reaching the top) brings the title and its controls back within reach.
  inspectorScroll.addEventListener(
    "scroll",
    () => {
      if (disposed || signal.aborted) return;
      const top = inspectorScroll.scrollTop;
      const hide = top > 24 && top > inspectorScrollTop;
      inspectorScrollTop = top;
      inspectorBar.classList.toggle("lp-inspector-bar-hidden", hide);
    },
    { passive: true },
  );

  // Drag the bar to move the window — vertically and horizontally — off its
  // pinned spot: the dragged offset survives refreshes and rides along with
  // the ordinary re-pinning, the window never leaves the viewport and never
  // tucks under a header (its top stays at or below the header pin, and at
  // least a bar's worth stays on screen), and a double-click on the bar puts
  // it back where it pins by default. Presses on the bar's own controls (tabs,
  // Expand, Close, the grip) never become a move.
  inspectorBar.addEventListener("pointerdown", (event: PointerEvent) => {
    if (signal.aborted || disposed || inspectorExpanded) return;
    const pressed = event.target as HTMLElement | null;
    if (pressed?.closest(".lp-tab, .lp-button-host, .lp-inspector-grip")) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    try {
      inspectorBar.setPointerCapture(event.pointerId);
    } catch {
      // Hosts without pointer capture still get the listener-based drag.
    }
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffset = inspectorOffset ?? { x: 0, y: 0 };
    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== event.pointerId) return;
      const view = document.defaultView;
      const height = view?.innerHeight ?? 0;
      const pinnedTop = pinnedTopUnderHeaders();
      // The header pin is the drag floor: the window may move anywhere below
      // it, but never tuck under a header on the way up.
      const minY = 0;
      const maxY = height > 0 ? Math.max(height - 96 - pinnedTop, minY) : Number.MAX_SAFE_INTEGER;
      inspectorOffset = {
        x: startOffset.x + (move.clientX - startX),
        y: Math.max(Math.min(startOffset.y + (move.clientY - startY), maxY), minY),
      };
      positionInspector();
    };
    const onEnd = (end: PointerEvent): void => {
      if (end.pointerId !== event.pointerId) return;
      inspectorBar.removeEventListener("pointermove", onMove);
      inspectorBar.removeEventListener("pointerup", onEnd);
      inspectorBar.removeEventListener("pointercancel", onEnd);
    };
    inspectorBar.addEventListener("pointermove", onMove);
    inspectorBar.addEventListener("pointerup", onEnd);
    inspectorBar.addEventListener("pointercancel", onEnd);
  });
  inspectorBar.addEventListener("dblclick", (event) => {
    if (signal.aborted || disposed) return;
    const pressed = event.target as HTMLElement | null;
    if (pressed?.closest(".lp-tab, .lp-button-host, .lp-inspector-grip")) return;
    inspectorOffset = null;
    positionInspector();
  });

  // Drag the left grip to widen or narrow the window; the window stays
  // anchored to the hub's right edge. Double-click resets to the default.
  // Expanded mode covers the whole hub already, so there is nothing to drag.
  inspectorGrip.addEventListener("pointerdown", (event) => {
    if (signal.aborted || disposed || inspectorExpanded) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    inspectorGrip.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = inspectorContainer.getBoundingClientRect().width;
    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== event.pointerId) return;
      const hubRect = root.getBoundingClientRect();
      inspectorWidth = Math.max(280, Math.min(startWidth + (startX - move.clientX), hubRect.width));
      positionInspector();
    };
    const onEnd = (end: PointerEvent): void => {
      if (end.pointerId !== event.pointerId) return;
      inspectorGrip.removeEventListener("pointermove", onMove);
      inspectorGrip.removeEventListener("pointerup", onEnd);
      inspectorGrip.removeEventListener("pointercancel", onEnd);
    };
    inspectorGrip.addEventListener("pointermove", onMove);
    inspectorGrip.addEventListener("pointerup", onEnd);
    inspectorGrip.addEventListener("pointercancel", onEnd);
  });
  inspectorGrip.addEventListener("dblclick", () => {
    if (signal.aborted || disposed) return;
    inspectorWidth = null;
    positionInspector();
  });

  function renderInspector(): void {
    if (disposed || signal.aborted) return;
    const node = path ? nodeById(path, selectedNodeId) : null;
    inspectorContainer.hidden = node === null;
    // A different node is fresh content: rewind to the top with the bar back
    // in place. Background refreshes of the same node keep the learner's
    // scroll position and the bar in whatever state the scrolling left it.
    if (node?.id !== lastInspectorNodeId) {
      lastInspectorNodeId = node?.id ?? null;
      inspectorScrollTop = 0;
      inspectorScroll.scrollTop = 0;
      inspectorBar.classList.remove("lp-inspector-bar-hidden");
    }
    if (node !== null) positionInspector();
    // One window, two tabs: the label carries the honest item count (no
    // unread or new state anywhere), and exactly one content div shows.
    const itemCount = workspace?.items.length ?? 0;
    workspaceTab.textContent =
      itemCount === 0 ? "Workspace ledger" : `Workspace ledger (${itemCount} item${itemCount === 1 ? "" : "s"})`;
    const showWorkspace = inspectorTab === "workspace";
    detailsTab.setAttribute("aria-pressed", showWorkspace ? "false" : "true");
    workspaceTab.setAttribute("aria-pressed", showWorkspace ? "true" : "false");
    inspectorDetails.hidden = showWorkspace;
    workspaceBody.hidden = !showWorkspace;
    inspector.render(path, node);
    // The ledger renders with the window open regardless of the active tab:
    // switching tabs is instant, with no refetch on the way in.
    workspacePane.render(path, node, workspace);
  }

  /** Tab switch: the ledger keeps its place across refreshes and node
   * switches; only a closed window or a new path resets to the details. */
  function selectInspectorTab(next: "details" | "workspace"): void {
    if (disposed || signal.aborted) return;
    inspectorTab = next;
    renderInspector();
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
    exportButton.update({ disabled: path === null });
    // Keep the Architect visible while there is no path yet: that is how one is made.
    architectContainer.hidden = !refineOpen && summaries.length > 0;
    // With the Architect pane closed, the path roadmap owns the whole
    // section instead of an empty second grid column.
    body.classList.toggle("lp-hub-body-single", architectContainer.hidden);
  }

  function renderAll(): void {
    if (disposed || signal.aborted) return;
    renderHeader();
    // The overview is the dashboard over existing paths; an empty hub keeps a
    // single empty state (the path pane's) instead of two identical messages.
    overviewContainer.hidden = summaries.length === 0;
    overview.render(summaries, selectedPathId);
    renderPathView();
    renderInspector();
  }

  function ensureSelection(): void {
    if (!path) {
      selectedNodeId = null;
      return;
    }
    if (nodeById(path, selectedNodeId)) return;
    selectedNodeId = nodeDeselected ? null : path.modules[0]?.nodes[0]?.id ?? null;
  }

  /** The workspace is a refetch-on-change surface like the path itself: the
   * notification is a hint, the manifest read here is authoritative. The
   * read is `workspace.resync`, so external edits to the files (the truth)
   * land in the ledger the moment the hub looks. */
  async function refreshWorkspace(token: number, pathId: string): Promise<void> {
    if (disposed || signal.aborted) return;
    try {
      const result = await ctx.call<{ workspace: WorkspaceManifest | null }>("workspace.resync", {
        pathId,
      });
      if (!live(token)) return;
      workspace = result.workspace;
    } catch {
      // A missing workspace read must not take the hub down.
      if (live(token)) workspace = null;
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

  function openChatDraft(draft: string): void {
    refineOpen = true;
    pane.startNew(draft);
    renderHeader();
  }

  async function refreshAll(): Promise<void> {
    if (disposed || signal.aborted) return;
    const token = ++loadToken;
    // A top-bar navigation may have arrived before this mount finished loading.
    const target = consumePathHubTarget();
    if (target?.kind === "chat-draft") openChatDraft(target.draft);
    if (target?.kind === "node") {
      nodeDeselected = false;
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
          nodeDeselected = false;
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
        await refreshWorkspace(token, path.id);
        if (!live(token)) return;
      } else {
        chatStatuses.clear();
        workspace = null;
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
    nodeDeselected = false;
    // A new path is a new window: it opens on the details tab, and the new
    // path's ledger is one tab click away.
    inspectorTab = "details";
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
        nodeDeselected = false;
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

  /** A note may be created unlinked or linked to several nodes at once; the
   * links array is the whole filing decision (workspace.saveNote's optional
   * links — the only backend surface change in this rework). */
  async function saveWorkspaceNote(input: AddNoteInput): Promise<void> {
    if (disposed || signal.aborted || !path) return;
    try {
      await ctx.call("workspace.saveNote", {
        pathId: path.id,
        title: input.title,
        markdown: input.markdown,
        links: [...input.links],
      });
      if (disposed || signal.aborted) return;
      showError(null);
      await refreshAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(`Could not save the note: ${problem instanceof Error ? problem.message : String(problem)}`);
    }
  }

  /** A dropped (or Architect-uploaded) document: one learner write stores it
   * in the global source library and files the node-linked manifest entry. */
  async function saveWorkspaceSource(input: AddSourceInput): Promise<void> {
    if (disposed || signal.aborted || !path) return;
    try {
      await ctx.call("workspace.saveSource", {
        pathId: path.id,
        name: input.name,
        markdown: input.markdown,
        links: [...input.links],
      });
      if (disposed || signal.aborted) return;
      showError(null);
      await refreshAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(`Could not file the document: ${problem instanceof Error ? problem.message : String(problem)}`);
    }
  }

  /** Learner filing from the pane's node picker: the picker sends the item's
   * whole links array (new links rel informs), so one save covers link and
   * unlink across several nodes at once. */
  async function setWorkspaceItemLinks(
    itemId: string,
    links: readonly WorkspaceItemLink[],
  ): Promise<void> {
    if (disposed || signal.aborted || !path) return;
    try {
      await ctx.call("workspace.updateItemMeta", {
        pathId: path.id,
        itemId,
        links: [...links],
      });
      if (disposed || signal.aborted) return;
      showError(null);
      await refreshAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(`Could not save the links: ${problem instanceof Error ? problem.message : String(problem)}`);
    }
  }

  /** Lazy content read, used only when the learner opens an item in the pane's
   * viewer: the ledger itself never fetches item content. */
  async function readWorkspaceItem(itemId: string): Promise<string | null> {
    if (disposed || signal.aborted || !path) {
      throw new Error("The path is not available.");
    }
    const result = await ctx.call<{ content: string | null }>("workspace.readItem", {
      pathId: path.id,
      itemId,
    });
    return result.content ?? null;
  }

  /** Reveal the selected path's workspace folder in the host OS file manager
   * (workspace.openDirectory). A failure surfaces in the hub's error line; a
   * success opens the folder and changes nothing. */
  async function openWorkspaceDirectory(pathId: string): Promise<void> {
    if (disposed || signal.aborted) return;
    try {
      await ctx.call("workspace.openDirectory", { pathId });
      if (disposed || signal.aborted) return;
      showError(null);
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(
        `Could not open the workspace folder: ${
          problem instanceof Error ? problem.message : String(problem)
        }`,
      );
    }
  }

  /** Hand one item's content file to the OS (workspace.openItem): the system
   * opens the learner's chosen application, prompting for one wherever no
   * default is registered. A failure surfaces in the hub's error line; a
   * success changes nothing in the store. */
  async function openWorkspaceItem(pathId: string, itemId: string): Promise<void> {
    if (disposed || signal.aborted) return;
    try {
      await ctx.call("workspace.openItem", { pathId, itemId });
      if (disposed || signal.aborted) return;
      showError(null);
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(
        `Could not open the item in an editor: ${
          problem instanceof Error ? problem.message : String(problem)
        }`,
      );
    }
  }

  async function deleteWorkspaceItem(itemId: string): Promise<void> {
    if (disposed || signal.aborted || !path) return;
    try {
      await ctx.call("workspace.deleteItem", { pathId: path.id, itemId });
      if (disposed || signal.aborted) return;
      showError(null);
      await refreshAll();
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(`Could not delete the item: ${problem instanceof Error ? problem.message : String(problem)}`);
    }
  }

  async function exportCurrentPath(format: ExportFormat): Promise<void> {
    if (disposed || signal.aborted || path === null) return;
    try {
      const exported = await ctx.call<ExportedLearningPath>("paths.export", {
        pathId: path.id,
        format,
      });
      if (disposed || signal.aborted) return;
      (options.onExport ?? ((item) => triggerBrowserDownload(document, item)))(exported);
      showError(null);
    } catch (problem) {
      if (disposed || signal.aborted) return;
      showError(
        `Could not export the learning path: ${problem instanceof Error ? problem.message : String(problem)}`,
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

  const exportButton = ctx.ui.mountButton(
    exportHost,
    {
      label: "Export Path",
      variant: "outline",
      size: "sm",
      onClick: () => {
        if (signal.aborted || disposed || path === null) return;
        const handle = ctx.ui.openMenu(
          exportHost,
          {
            label: "Export learning path",
            preferredSide: "down",
            items: [
              {
                key: "export-json",
                label: "Export as JSON",
                onSelect: () => void exportCurrentPath("json"),
              },
              {
                key: "export-markdown",
                label: "Export as Markdown",
                onSelect: () => void exportCurrentPath("markdown"),
              },
            ],
          },
          { signal },
        );
        handles.push(handle);
      },
    },
    { signal },
  );
  handles.push(exportButton);

  const inspectorExpandButton = ctx.ui.mountButton(
    inspectorExpandHost,
    {
      label: "Expand",
      title: "Stretch the window across the hub",
      variant: "outline",
      size: "icon-xs",
      icon: EXPAND_ICON,
      iconOnly: true,
      onClick: () => {
        if (signal.aborted || disposed) return;
        toggleInspectorExpanded(!inspectorExpanded);
      },
    },
    { signal },
  );
  handles.push(inspectorExpandButton);

  const inspectorCloseButton = ctx.ui.mountButton(
    inspectorCloseHost,
    {
      label: "Close",
      title: "Close",
      variant: "outline",
      size: "icon-xs",
      icon: CLOSE_ICON,
      iconOnly: true,
      onClick: () => {
        if (signal.aborted || disposed) return;
        selectNode(null);
      },
    },
    { signal },
  );
  handles.push(inspectorCloseButton);

  pathSelect.addEventListener("change", () => {
    if (signal.aborted || disposed) return;
    void selectPath(pathSelect.value);
  });

  const offNotification = ctx.onNotification((event) => {
    if (signal.aborted || disposed) return;
    if (event.topic === EVENT_PATHS_CHANGED) {
      const data = event.data as { id?: unknown; created?: unknown } | undefined;
      if (data?.created === true && typeof data.id === "string") createdPathId = data.id;
      void refreshAll();
      return;
    }
    if (event.topic === EVENT_WORKSPACE_CHANGED) {
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
    if (target.kind === "chat-draft") {
      openChatDraft(target.draft);
      return;
    }
    nodeDeselected = false;
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

  // A host resize can rewrap the header (its height changes with the goal
  // text), and scrolling the page moves the hub past the viewport top, so the
  // floating window re-pins instead of drifting out of view. Scroll events do
  // not bubble, but the capture listener still sees them from any host
  // scroll container. The workspace pane needs no pinning: it is a grid
  // column, and the page scrolls it like every other pane.
  const onViewChange = (): void => {
    if (!disposed && !signal.aborted && !inspectorContainer.hidden) positionInspector();
  };
  const defaultView = document.defaultView;
  if (defaultView) defaultView.addEventListener("resize", onViewChange);
  document.addEventListener("scroll", onViewChange, { capture: true, passive: true });

  const onAbort = (): void => {
    if (disposed) return;
    disposed = true;
    loadToken += 1;
    offNotification();
    offNavigation();
    offResync();
    if (defaultView) defaultView.removeEventListener("resize", onViewChange);
    document.removeEventListener("scroll", onViewChange, { capture: true });
    for (const handle of handles.reverse()) handle.dispose();
    handles.length = 0;
    disposeCards();
    inspector.dispose();
    workspacePane.dispose();
    overview.dispose();
    pane.dispose();
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
