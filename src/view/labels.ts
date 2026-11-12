/** Presentation labels for the Path Hub. The domain stays authoritative; these
 * only decide what a learner reads, never what gets stored. */
import type { ArtifactType, ErrorCategory, NodeType, ProgressionState } from "../domain.ts";
import { artifactCatalogEntry } from "../domain.ts";

export const NODE_TYPE_LABELS: Readonly<Record<NodeType, string>> = {
  holistic: "Holistic",
  concept: "Concept",
  contrast: "Contrast",
  skill: "Skill",
  checkpoint: "Checkpoint",
  bridge: "Bridge",
};

/** Theme-friendly CSS colors; the host badge tints the background from these. */
export const NODE_TYPE_COLORS: Readonly<Record<NodeType, string>> = {
  holistic: "var(--chart-1, #6366f1)",
  concept: "var(--chart-2, #0ea5e9)",
  contrast: "var(--chart-3, #f59e0b)",
  skill: "var(--chart-4, #10b981)",
  checkpoint: "var(--chart-5, #8b5cf6)",
  bridge: "var(--chart-6, #ef4444)",
};

export const PROGRESSION_LABELS: Readonly<Record<ProgressionState, string>> = {
  unstarted: "Unstarted",
  in_progress: "In progress",
  consolidated: "Consolidated",
};

export const PROGRESSION_COLORS: Readonly<Record<ProgressionState, string>> = {
  unstarted: "var(--muted-foreground, #71717a)",
  in_progress: "var(--chart-3, #f59e0b)",
  consolidated: "var(--chart-4, #10b981)",
};

export const ERROR_CATEGORY_LABELS: Readonly<Record<ErrorCategory, string>> = {
  misconception: "Misconception",
  discrimination_error: "Discrimination error",
  prerequisite_gap: "Prerequisite gap",
  procedural_slip: "Procedural slip",
  cue_failure: "Cue failure",
};

export function artifactLabel(type: ArtifactType): string {
  return artifactCatalogEntry(type).label;
}
