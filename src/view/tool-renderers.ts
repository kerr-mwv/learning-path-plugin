/** Learning Path — compact inline cards for native learning_path_* tool results.
 *
 * Rendering only: a renderer never creates pending input, runs a tool or changes
 * learner data. The card stays to one line plus an optional detail, so a child
 * session's transcript is not dominated by long briefs. Missing/errored output
 * falls back to readable text rather than model HTML.
 */
import type { PluginFrontendContext, PluginToolRenderer, PluginToolRenderProps } from "learnharness-plugin-api";
import { LEARNING_PATH_TOOL_NAMES } from "../tool-names.ts";
import type { ErrorCategory, PivotProposalType } from "../domain.ts";
import { ERROR_CATEGORY_LABELS } from "./labels.ts";

const PIVOT_LABELS: Record<PivotProposalType, string> = {
  bridge: "bridge node",
  contrast: "contrast node",
  skill: "skill drill",
  holistic: "holistic node",
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function summary(tool: PluginToolRenderProps): { headline: string; detail?: string } {
  const output = record(tool.output);
  const nodeTitle = text(output.nodeTitle) ?? "this node";
  switch (tool.toolName) {
    case "learning_path_get_brief": {
      const watchpoints = Array.isArray(output.watchpoints) ? output.watchpoints.length : 0;
      const artifact = record(output.artifact);
      const artifactLabel = text(artifact.label);
      return {
        headline: `Brief for ${nodeTitle}`,
        detail: `${watchpoints} watchpoint${watchpoints === 1 ? "" : "s"}${
          artifactLabel ? ` · ${artifactLabel}` : ""
        }`,
      };
    }
    case "learning_path_update_progress": {
      const progression = text(output.progression) ?? "updated";
      const artifactNote = text(output.artifactNote);
      return {
        headline: `${nodeTitle}: ${progression.replace("_", " ")}`,
        ...(artifactNote ? { detail: `Artifact note: ${artifactNote}` } : {}),
      };
    }
    case "learning_path_log_error": {
      const category = text(output.category) as ErrorCategory | null;
      const label = category ? (ERROR_CATEGORY_LABELS[category] ?? category) : "error";
      const message = text(output.summary);
      return {
        headline: `Logged ${label} on ${nodeTitle}`,
        ...(message ? { detail: message } : {}),
      };
    }
    case "learning_path_suggest_pivot": {
      const proposal = text(output.proposalType) as PivotProposalType | null;
      const label = proposal ? (PIVOT_LABELS[proposal] ?? proposal) : "pivot";
      const title = text(output.title) ?? "detour";
      return {
        headline: `Advisory ${label}: ${title}`,
        detail: "Pending; the path was not changed. The learner decides.",
      };
    }
    default:
      return { headline: tool.toolName };
  }
}

function fallbackText(tool: PluginToolRenderProps): string | null {
  if (tool.state === "output-error") return text(tool.errorText) ?? "The tool failed.";
  if (tool.state === "input-streaming") return "Preparing…";
  if (tool.state === "input-available") return "Running…";
  const content = tool.result?.content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (record(part).type === "text" ? text(record(part).text) : null))
      .filter((part): part is string => part !== null);
    if (parts.length > 0) return parts.join(" ");
  }
  return null;
}

function rendererFor(toolName: string): PluginToolRenderer {
  return {
    toolName,
    mount(container, tool) {
      const document = container.ownerDocument;
      const card = document.createElement("div");
      card.className = "lp-tool-card";
      card.dataset.tool = toolName;
      card.dataset.state = tool.state;

      const line = document.createElement("div");
      line.className = "lp-tool-line";
      const dot = document.createElement("span");
      dot.className = "lp-tool-dot";
      dot.setAttribute("aria-hidden", "true");
      const headline = document.createElement("strong");
      const detail = document.createElement("span");
      detail.className = "lp-tool-detail";

      if (tool.state === "output-available") {
        const view = summary(tool);
        headline.textContent = view.headline;
        if (view.detail) detail.textContent = view.detail;
      } else {
        headline.textContent = {
          "learning_path_get_brief": "Reading the Learning Path brief",
          "learning_path_update_progress": "Recording node progress",
          "learning_path_log_error": "Logging a cognitive error",
          "learning_path_suggest_pivot": "Recording an advisory pivot",
        }[toolName] ?? toolName;
        const pending = fallbackText(tool);
        if (pending) detail.textContent = pending;
      }

      if (tool.state === "output-error") {
        card.dataset.error = "true";
        const error = document.createElement("span");
        error.className = "lp-tool-error";
        error.textContent = fallbackText(tool) ?? "The tool failed.";
        detail.textContent = "";
        line.append(dot, headline);
        card.append(line, error);
      } else {
        line.append(dot, headline);
        if (detail.textContent) line.append(detail);
        card.append(line);
      }

      container.append(card);
      return () => card.remove();
    },
  };
}

/** Register all four renderers; the returned disposer unregisters and unmounts. */
export function registerLearningPathToolRenderers(ctx: PluginFrontendContext): () => void {
  const disposers = LEARNING_PATH_TOOL_NAMES.map((toolName) =>
    ctx.registerToolRenderer(rendererFor(toolName)),
  );
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}

/** Exported for tests: render one tool without a full activation. */
export function mountLearningPathToolCard(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  tool: PluginToolRenderProps,
): ReturnType<PluginToolRenderer["mount"]> {
  return rendererFor(tool.toolName).mount(container, tool);
}
