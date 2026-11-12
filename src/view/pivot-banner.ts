/** Quiet advisory pivot card for the Node Inspector.
 *
 * A pending `PivotSuggestion` is only a proposal: it explains the diagnosed
 * reason and lets the learner decide. Accept inserts the proposed repair node
 * next to the current node, Discuss hands the rationale to the Architect, and
 * Dismiss closes the proposal without touching path structure. Nothing here
 * mutates the path; the caller owns the backend calls and feeds state back in.
 */
import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import type { LearningPath, PathNode, PivotSuggestion } from "../domain.ts";
import { NODE_TYPE_LABELS } from "./labels.ts";

export type PivotDecision = "accept" | "dismiss";

export interface PivotBannerOptions {
  /** Accept inserts an adjacent node; dismiss only changes the suggestion status. */
  decide(pivotId: string, decision: PivotDecision): void | Promise<void>;
  /** Open the Architect with the pivot's diagnosis as context. */
  discuss(pivot: PivotSuggestion, node: PathNode): void | Promise<void>;
}

export interface PivotBanner {
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

export function createPivotBanner(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: PivotBannerOptions,
): PivotBanner {
  const document = container.ownerDocument;
  const root = element(document, "div", "lp-pivot-banner");
  root.setAttribute("aria-live", "polite");
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
    extra: { variant?: "default" | "link" | "outline" | "ghost" | "secondary" | "destructive"; size?: "xs" | "sm" } = {},
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

  return {
    render(path, node) {
      if (disposed || signal.aborted) return;
      clear();
      if (!path || !node) return;
      const pending = node.pivotSuggestions.filter((pivot) => pivot.status === "pending");
      if (pending.length === 0) return;

      for (const pivot of pending) {
        const card = element(document, "aside", "lp-pivot-card");
        card.dataset.pivotId = pivot.id;
        card.dataset.proposalType = pivot.proposalType;
        const heading = element(document, "h4", "lp-pivot-title");
        heading.append(
          element(
            document,
            "span",
            "lp-pivot-kicker",
            `Advisory ${NODE_TYPE_LABELS[pivot.proposalType].toLowerCase()} proposal`,
          ),
        );
        heading.append(element(document, "span", "lp-pivot-heading", pivot.title));
        card.append(heading);

        card.append(
          element(
            document,
            "p",
            "lp-pivot-rationale",
            `Not sticking because: ${pivot.rationale}`,
          ),
        );
        card.append(
          element(
            document,
            "p",
            "lp-pivot-note",
            "Nothing changes until you decide. Accepting inserts one node next to this one.",
          ),
        );

        const actions = element(document, "div", "lp-pivot-actions");
        card.append(actions);
        button(actions, "Accept & Insert Node", () => {
          void options.decide(pivot.id, "accept");
        }, { variant: "default" });
        button(actions, "Discuss with Architect", () => {
          void options.discuss(pivot, node);
        }, { variant: "outline" });
        button(actions, "Dismiss", () => {
          void options.decide(pivot.id, "dismiss");
        }, { variant: "ghost" });
        root.append(card);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      root.remove();
    },
  };
}

/** The prompt the Path Hub sends when a learner chooses "Discuss with Architect". */
export function pivotDiscussionPrompt(pivot: PivotSuggestion, node: PathNode): string {
  return [
    `I want to discuss a ${pivot.proposalType} pivot on the node "${node.title}".`,
    `The observed problem: ${pivot.rationale}`,
    `Proposed repair: ${pivot.title}.`,
    "Explain whether this repair fits the path's source spine and dependencies, and propose the smallest change. Do not rewrite the path without my explicit agreement.",
  ].join("\n");
}
