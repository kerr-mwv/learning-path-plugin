/** Interactive Error Ledger for the Node Inspector.
 *
 * Errors are grouped by cognitive root cause, never by grade. Each entry can be
 * resolved/unresolved and can carry a learner-written reflection note. Active
 * watchpoints inherited from interleaved predecessors and upstream nodes are
 * listed separately, because those gaps travel into this node's child sessions.
 *
 * The ledger is controlled: `render` receives authoritative state after each
 * refetch, and every write is reported to the caller (the Path Hub forwards it to
 * the backend). Widget handles belong to the per-mount signal.
 */
import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import { ERROR_CATEGORIES } from "../domain.ts";
import type { ErrorCategory, ErrorEntry, LearningPath, PathNode } from "../domain.ts";
import { collectErrorWatchpoints } from "../framework.ts";
import type { ErrorWatchpoint } from "../framework.ts";
import { ERROR_CATEGORY_LABELS } from "./labels.ts";

export interface ErrorLedgerChange {
  readonly resolved?: boolean;
  /** `null` clears the reflection. */
  readonly notes?: string | null;
}

export interface ErrorLedgerOptions {
  /** Persist one entry change; the caller refetches and calls `render` again. */
  update(errorId: string, change: ErrorLedgerChange): void | Promise<void>;
  /** Follow an inherited watchpoint back to the node that owns it. */
  selectNode?(nodeId: string): void;
}

export interface ErrorLedger {
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

function entriesByCategory(
  node: PathNode,
): readonly (readonly [ErrorCategory, readonly ErrorEntry[]])[] {
  return ERROR_CATEGORIES.flatMap((category) => {
    const entries = node.errors.filter((entry) => entry.category === category);
    return entries.length === 0 ? [] : [[category, entries] as const];
  });
}

export function createErrorLedger(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: ErrorLedgerOptions,
): ErrorLedger {
  const document = container.ownerDocument;
  const root = element(document, "div", "lp-error-ledger");
  root.setAttribute("aria-label", "Error ledger");
  container.append(root);

  let handles: PluginWidgetHandle<unknown>[] = [];
  let disposed = false;

  const clear = (): void => {
    for (const handle of handles.reverse()) handle.dispose();
    handles = [];
    root.replaceChildren();
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

  const badge = (parent: HTMLElement, text: string, color: string): void => {
    const host = element(document, "span", "lp-badge-host");
    parent.append(host);
    handles.push(ctx.ui.mountBadge(host, { text, color }, { signal }));
  };

  const noteEditor = (parent: HTMLElement, entry: ErrorEntry): void => {
    const row = element(document, "div", "lp-error-note-row");
    const label = element(document, "label", "lp-field");
    label.append(element(document, "span", "lp-field-label", "Reflection note"));
    const input = element(document, "textarea", "lp-error-note-input");
    input.setAttribute("aria-label", `Reflection note for ${entry.summary}`);
    input.rows = 2;
    input.maxLength = 2000;
    input.value = entry.notes ?? "";
    input.placeholder = "What would prevent this next time?";
    label.append(input);
    row.append(label);

    const actions = element(document, "div", "lp-error-note-actions");
    row.append(actions);
    button(actions, entry.notes === undefined ? "Save note" : "Update note", () => {
      const value = input.value.trim();
      void options.update(entry.id, { notes: value.length === 0 ? null : value });
    });
    if (entry.notes !== undefined) {
      button(actions, "Clear note", () => {
        void options.update(entry.id, { notes: null });
      }, { variant: "ghost" });
    }
    parent.append(row);
  };

  const renderEntry = (parent: HTMLElement, entry: ErrorEntry): void => {
    const article = element(
      document,
      "article",
      `lp-error-entry ${entry.resolved ? "lp-error-resolved" : "lp-error-active"}`,
    );
    article.dataset.errorId = entry.id;

    const header = element(document, "header", "lp-error-entry-header");
    const summary = element(document, "p", "lp-error-summary", entry.summary);
    header.append(summary);
    const badges = element(document, "span", "lp-badge-row");
    badge(
      badges,
      entry.resolved ? "Resolved" : "Active watchpoint",
      entry.resolved ? "var(--chart-4, #10b981)" : "var(--chart-6, #ef4444)",
    );
    header.append(badges);
    article.append(header);

    const meta = element(document, "p", "lp-error-meta");
    meta.textContent = entry.resolved
      ? `Resolved${entry.resolvedAt === undefined ? "" : ` ${entry.resolvedAt.slice(0, 10)}`}`
      : `Logged ${entry.createdAt.slice(0, 10)}`;
    article.append(meta);

    if (entry.notes !== undefined) {
      const note = element(document, "blockquote", "lp-error-note", entry.notes);
      article.append(note);
    }

    const actions = element(document, "div", "lp-error-actions");
    article.append(actions);
    button(
      actions,
      entry.resolved ? "Mark unresolved" : "Mark resolved",
      () => {
        void options.update(entry.id, { resolved: !entry.resolved });
      },
      { variant: entry.resolved ? "ghost" : "default" },
    );
    noteEditor(actions, entry);
    parent.append(article);
  };

  const renderInherited = (watchpoints: readonly ErrorWatchpoint[]): void => {
    const section = element(document, "section", "lp-inherited-watchpoints");
    section.append(element(document, "h4", "lp-section-title", "Inherited active watchpoints"));
    if (watchpoints.length === 0) {
      section.append(
        element(document, "p", "lp-muted", "No unresolved errors carry over from earlier nodes."),
      );
      root.append(section);
      return;
    }
    section.append(
      element(
        document,
        "p",
        "lp-muted",
        "These gaps come from interleaved or upstream nodes and follow this node's child sessions.",
      ),
    );
    const list = element(document, "ul", "lp-watchpoint-list");
    for (const watchpoint of watchpoints) {
      const item = element(document, "li", "lp-watchpoint-inherited");
      item.dataset.sourceNodeId = watchpoint.nodeId;
      const text = element(document, "span", "lp-watchpoint-text");
      text.append(
        element(
          document,
          "strong",
          "lp-watchpoint-category",
          ERROR_CATEGORY_LABELS[watchpoint.entry.category],
        ),
      );
      text.append(element(document, "span", undefined, watchpoint.entry.summary));
      item.append(text);
      const source = element(
        document,
        "span",
        "lp-watchpoint-source",
        `From ${watchpoint.nodeTitle}`,
      );
      item.append(source);
      if (options.selectNode) {
        button(
          item,
          watchpoint.nodeTitle,
          () => options.selectNode?.(watchpoint.nodeId),
          { variant: "link" },
        );
      }
      list.append(item);
    }
    section.append(list);
    root.append(section);
  };

  const empty = (): void => {
    root.append(element(document, "p", "lp-muted", "Select a node to inspect its errors."));
  };

  return {
    render(path, node) {
      if (disposed || signal.aborted) return;
      clear();
      if (!path || !node) {
        empty();
        return;
      }

      const groups = entriesByCategory(node);
      if (groups.length === 0) {
        root.append(
          element(
            document,
            "p",
            "lp-muted",
            "No errors are logged on this node. Child sessions add them by root cause.",
          ),
        );
      } else {
        for (const [category, entries] of groups) {
          const group = element(document, "section", "lp-error-group");
          group.dataset.category = category;
          const heading = element(document, "h4", "lp-section-title");
          heading.append(
            element(
              document,
              "span",
              "lp-error-category",
              `${ERROR_CATEGORY_LABELS[category]} (${entries.length})`,
            ),
          );
          group.append(heading);
          for (const entry of entries) renderEntry(group, entry);
          root.append(group);
        }
      }

      const inherited = collectErrorWatchpoints(path, node.id).filter(
        (watchpoint) => watchpoint.nodeId !== node.id,
      );
      renderInherited(inherited);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      root.remove();
    },
  };
}
