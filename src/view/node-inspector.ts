/** Node Inspector for the Path Hub.
 *
 * Shows one selected node: goal, canonical source anchor, the light pre-reading
 * callout, interleaved prior nodes, the artifact choice with the framework's
 * justification, manual progression, and child-session actions.
 *
 * Everything rendered here is controlled by the caller: `render` receives the
 * authoritative path and node after each refetch, and edits are reported to the
 * backend. Every widget is bound to the per-mount signal and disposed on each
 * render or unmount.
 */
import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import {
  ARTIFACT_CATALOG,
  PROGRESSION_STATES,
  artifactCatalogEntry,
  formatSourceAnchor,
  recommendedArtifactsFor,
} from "../domain.ts";
import type {
  ArtifactType,
  LearningPath,
  PathNode,
  PivotSuggestion,
  ProgressionState,
} from "../domain.ts";
import type { ChildSessionKind } from "../domain.ts";
import type { SessionStatus } from "../session-types.ts";
import { createKnowledgePanel } from "./knowledge-panel.ts";
import { createErrorLedger } from "./error-ledger.ts";
import type { ErrorLedgerChange } from "./error-ledger.ts";
import { createPivotBanner } from "./pivot-banner.ts";
import type { PivotDecision } from "./pivot-banner.ts";
import {
  NODE_TYPE_COLORS,
  NODE_TYPE_LABELS,
  PROGRESSION_COLORS,
  PROGRESSION_LABELS,
  artifactLabel,
} from "./labels.ts";

export interface NodeInspectorChange {
  readonly progression?: ProgressionState;
  readonly artifactType?: ArtifactType | null;
}

export interface NodeInspectorOptions {
  /** Navigate to a linked native child chat. */
  openSession(chatId: string): void;
  /** Link a native session that already exists. */
  linkExistingSession(): void | Promise<void>;
  /** Create + link + open a new native teaching/practice chat. */
  startSession(kind: ChildSessionKind): void | Promise<void>;
  /** Remove a stale link; the native chat is untouched. */
  unlinkSession(chatId: string): void | Promise<void>;
  /** Existence of each linked chat, refreshed with the path. */
  chatStatus?: ReadonlyMap<string, SessionStatus>;
  /** Follow an interleaved prior-node link. */
  selectNode(nodeId: string): void;
  /** Persist one manual inspector edit through the plugin backend. */
  updateNode(change: NodeInspectorChange): void | Promise<void>;
  /** Resolve/unresolve one ledger entry or edit its reflection note. */
  updateError(errorId: string, change: ErrorLedgerChange): void | Promise<void>;
  /** Accept or dismiss one advisory pivot proposal. */
  decidePivot(pivotId: string, decision: PivotDecision): void | Promise<void>;
  /** Hand a pivot diagnosis to the Architect for discussion. */
  discussPivot(pivot: PivotSuggestion, node: PathNode): void | Promise<void>;
}

export interface NodeInspector {
  render(path: LearningPath | null, node: PathNode | null): void;
  dispose(): void;
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

function findNode(path: LearningPath, nodeId: string): PathNode | null {
  for (const module of path.modules) {
    const node = module.nodes.find((candidate) => candidate.id === nodeId);
    if (node) return node;
  }
  return null;
}

/** Per-node override, then path default, then the framework's recommendation. */
export function effectiveArtifact(path: LearningPath, node: PathNode): ArtifactType {
  return node.artifactConfig?.type ?? path.artifactDefault ?? recommendedArtifactsFor(node.type)[0] ?? "none";
}

export function createNodeInspector(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: NodeInspectorOptions,
): NodeInspector {
  const document = container.ownerDocument;
  const root = element(document, "div", "lp-inspector");
  root.setAttribute("aria-label", "Node inspector");
  container.append(root);

  const pivotContainer = element(document, "div", "lp-pivot-host");
  const errorContainer = element(document, "div", "lp-error-ledger-host");
  const pivotBanner = createPivotBanner(ctx, pivotContainer, signal, {
    decide: options.decidePivot,
    discuss: options.discussPivot,
  });
  const errorLedger = createErrorLedger(ctx, errorContainer, signal, {
    update: options.updateError,
    selectNode: options.selectNode,
  });

  let disposeKnowledge: (() => void) | null = null;
  let handles: PluginWidgetHandle<unknown>[] = [];
  let disposed = false;

  const clear = (): void => {
    disposeKnowledge?.();
    disposeKnowledge = null;
    for (const handle of handles.reverse()) handle.dispose();
    handles = [];
    root.replaceChildren();
  };

  const badge = (parent: HTMLElement, text: string, color: string): void => {
    const host = element(document, "span", "lp-badge-host");
    parent.append(host);
    handles.push(ctx.ui.mountBadge(host, { text, color }, { signal }));
  };

  const button = (
    parent: HTMLElement,
    label: string,
    onClick: () => void,
    extra: { variant?: "default" | "link" | "outline" | "ghost" | "secondary"; size?: "xs" | "sm" } = {},
  ): void => {
    const host = element(document, "span", "lp-button-host");
    parent.append(host);
    handles.push(
      ctx.ui.mountButton(
        host,
        {
          label,
          variant: extra.variant ?? "outline",
          size: extra.size ?? "xs",
          onClick: () => {
            if (!signal.aborted && !disposed) onClick();
          },
        },
        { signal },
      ),
    );
  };

  const empty = (): void => {
    const heading = element(document, "h2", "lp-pane-title", "Node inspector");
    const hint = element(
      document,
      "p",
      "lp-muted",
      "Select a node in the path tree to see its source anchor, pre-reading and artifact.",
    );
    root.append(heading, hint);
  };

  const section = (title: string): HTMLElement => {
    const wrapper = element(document, "section", "lp-inspector-section");
    wrapper.append(element(document, "h3", "lp-section-title", title));
    root.append(wrapper);
    return wrapper;
  };

  const renderSelected = (path: LearningPath, node: PathNode): void => {
    root.dataset.nodeId = node.id;

    const header = element(document, "header", "lp-inspector-header");
    const titleRow = element(document, "div", "lp-inspector-title-row");
    titleRow.append(element(document, "h2", "lp-pane-title", node.title));
    const badges = element(document, "div", "lp-badge-row");
    titleRow.append(badges);
    header.append(titleRow);
    badge(badges, NODE_TYPE_LABELS[node.type], NODE_TYPE_COLORS[node.type]);
    badge(badges, PROGRESSION_LABELS[node.progression], PROGRESSION_COLORS[node.progression]);
    const unresolved = node.errors.filter((entry) => !entry.resolved).length;
    if (unresolved > 0) badge(badges, `${unresolved} unresolved`, "var(--chart-6, #ef4444)");
    root.append(header);

    const goal = element(document, "p", "lp-node-goal", node.goal);
    root.append(goal);
    root.append(pivotContainer);
    pivotBanner.render(path, node);

    const anchor = section("Canonical source");
    anchor.append(
      element(document, "p", "lp-source-anchor", formatSourceAnchor(node.sourceAnchor)),
    );

    const preReading = section("Light pre-reading");
    const callout = element(document, "aside", "lp-callout lp-prereading");
    callout.append(element(document, "strong", undefined, "Before the chat"));
    callout.append(
      element(
        document,
        "p",
        undefined,
        node.lightPreReading ??
          "No pre-reading suggested. Skim the source anchor for five minutes if the vocabulary is new.",
      ),
    );
    preReading.append(callout);

    const interleaving = section("Interleaved prior nodes");
    if (node.interleavesNodeIds.length === 0) {
      interleaving.append(element(document, "p", "lp-muted", "None yet."));
    } else {
      const list = element(document, "ul", "lp-link-list");
      for (const nodeId of node.interleavesNodeIds) {
        const item = element(document, "li");
        const prior = findNode(path, nodeId);
        if (prior) {
          button(item, prior.title, () => options.selectNode(nodeId), { variant: "link" });
        } else {
          item.append(element(document, "span", "lp-muted", `Missing node ${nodeId}`));
        }
        list.append(item);
      }
      interleaving.append(list);
    }

    const knowledge = section("Linked knowledge");
    disposeKnowledge = createKnowledgePanel(ctx, knowledge, signal, path, node);

    const artifact = section("Generative artifact");
    const effective = effectiveArtifact(path, node);
    const label = element(document, "label", "lp-field");
    label.append(element(document, "span", "lp-field-label", "Artifact"));
    const select = element(document, "select", "lp-select");
    select.setAttribute("aria-label", "Artifact type");
    const inherited = element(
      document,
      "option",
      undefined,
      `Path default — ${artifactLabel(path.artifactDefault ?? recommendedArtifactsFor(node.type)[0] ?? "none")}`,
    );
    inherited.value = "";
    select.append(inherited);
    const chosenArtifact = node.artifactConfig ? effective : "";
    for (const entry of ARTIFACT_CATALOG) {
      const option = element(document, "option", undefined, entry.label);
      option.value = entry.type;
      if (entry.type === chosenArtifact) option.selected = true;
      select.append(option);
    }
    if (chosenArtifact === "") inherited.selected = true;
    select.addEventListener("change", () => {
      if (signal.aborted || disposed) return;
      const value = select.value === "" ? null : (select.value as ArtifactType);
      void options.updateNode({ artifactType: value });
    });
    label.append(select);
    artifact.append(label);
    if (node.artifactConfig?.instructions) {
      artifact.append(
        element(
          document,
          "p",
          "lp-artifact-instructions",
          node.artifactConfig.instructions,
        ),
      );
    }

    const justification = artifactCatalogEntry(effective);
    const card = element(document, "div", "lp-artifact-justification");
    card.append(element(document, "h4", undefined, "Why the framework recommends this"));
    card.append(element(document, "p", undefined, justification.justification));
    card.append(
      element(
        document,
        "p",
        "lp-muted",
        `Best suited for: ${recommendedArtifactsFor(node.type)
          .map((type) => artifactLabel(type))
          .join(", ")}.`,
      ),
    );
    artifact.append(card);

    const progression = section("Progression");
    const progressionLabel = element(document, "label", "lp-field");
    progressionLabel.append(element(document, "span", "lp-field-label", "Manual status"));
    const progressionSelect = element(document, "select", "lp-select");
    progressionSelect.setAttribute("aria-label", "Progression");
    for (const state of PROGRESSION_STATES) {
      const option = element(document, "option", undefined, PROGRESSION_LABELS[state]);
      option.value = state;
      if (state === node.progression) option.selected = true;
      progressionSelect.append(option);
    }
    progressionSelect.addEventListener("change", () => {
      if (signal.aborted || disposed) return;
      void options.updateNode({ progression: progressionSelect.value as ProgressionState });
    });
    progressionLabel.append(progressionSelect);
    progression.append(progressionLabel);

    const errors = section("Error watchpoints");
    errors.append(errorContainer);
    errorLedger.render(path, node);

    const chats = section("Child chats");
    const chatActions = element(document, "div", "lp-chat-actions");
    button(chatActions, "Start Teaching Chat", () => {
      void options.startSession("teaching");
    }, { variant: "default" });
    button(chatActions, "Start Practice Chat", () => {
      void options.startSession("practice");
    }, { variant: "outline" });
    button(chatActions, "Link Existing Session…", () => {
      void options.linkExistingSession();
    }, { variant: "ghost" });
    chats.append(chatActions);

    if (node.childSessions.length === 0) {
      chats.append(
        element(
          document,
          "p",
          "lp-muted",
          "No child chats yet. Start one, or link an existing native session.",
        ),
      );
    } else {
      const list = element(document, "ul", "lp-chat-list");
      for (const chat of node.childSessions) {
        const status = options.chatStatus?.get(chat.chatId);
        const exists = status?.exists ?? true;
        const item = element(
          document,
          "li",
          exists ? "lp-chat-row" : "lp-chat-row lp-chat-missing",
        );
        const label = element(
          document,
          "span",
          "lp-chat-label",
          `${chat.kind === "teaching" ? "Teaching" : "Practice"} — ${chat.label}`,
        );
        item.append(label);
        if (!exists) {
          item.append(element(document, "span", "lp-missing-note", "Missing native chat"));
        }
        const rowActions = element(document, "span", "lp-chat-row-actions");
        item.append(rowActions);
        const menuHost = element(document, "span", "lp-button-host");
        rowActions.append(menuHost);
        const menuLabel = `Session actions for ${chat.label}`;
        handles.push(
          ctx.ui.mountButton(
            menuHost,
            {
              label: "Actions",
              variant: "ghost",
              size: "xs",
              title: menuLabel,
              onClick: () => {
                if (signal.aborted || disposed) return;
                handles.push(
                  ctx.ui.openMenu(
                    menuHost,
                    {
                      label: menuLabel,
                      preferredSide: "down",
                      items: [
                        ...(exists
                          ? [
                              {
                                key: "open",
                                label: "Open chat",
                                onSelect: () => {
                                  if (!signal.aborted && !disposed) options.openSession(chat.chatId);
                                },
                              },
                            ]
                          : []),
                        {
                          key: "unlink",
                          label: "Unlink chat",
                          onSelect: () => {
                            if (!signal.aborted && !disposed) void options.unlinkSession(chat.chatId);
                          },
                        },
                      ],
                    },
                    { signal },
                  ),
                );
              },
            },
            { signal },
          ),
        );
        list.append(item);
      }
      chats.append(list);
    }
  };

  return {
    render(path, node) {
      if (disposed || signal.aborted) return;
      clear();
      root.removeAttribute("data-node-id");
      if (!path || !node) {
        empty();
        pivotBanner.render(null, null);
        errorLedger.render(null, null);
        return;
      }
      renderSelected(path, node);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      pivotBanner.dispose();
      errorLedger.dispose();
      root.remove();
    },
  };
}
