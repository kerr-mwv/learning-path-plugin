/** Learning Path — deterministic JSON and Markdown exports.
 *
 * Formatting is pure: the backend validates a path, renders one of the two
 * supported representations and returns the bytes plus a safe download name.
 * Only `triggerBrowserDownload` touches the DOM, and only the document it is
 * handed. Nothing here writes plugin storage or native sessions.
 */
import {
  defaultArtifactFor,
  formatSourceAnchor,
  parseLearningPath,
} from "./domain.ts";
import type {
  ArtifactType,
  CanonicalReference,
  LearningPath,
  PathNode,
  PluginSettings,
  SourceSpine,
  UploadedSourceReference,
  WorkspaceItem,
} from "./domain.ts";
import {
  ERROR_CATEGORY_LABELS,
  NODE_TYPE_LABELS,
  PROGRESSION_LABELS,
  artifactLabel,
} from "./view/labels.ts";

export const EXPORT_FORMATS = ["json", "markdown"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportedLearningPath {
  readonly pathId: string;
  readonly title: string;
  readonly format: ExportFormat;
  readonly filename: string;
  readonly mimeType: "application/json" | "text/markdown";
  readonly content: string;
}

const MAX_SLUG_LENGTH = 80;

/** One workspace item prepared for export: the ledger entry plus its content
 * verbatim (null for `source` items, which reference the global sources store). */
export interface WorkspaceExportItem {
  readonly item: WorkspaceItem;
  readonly content: string | null;
}

/** Lowercase ASCII slug; every non-alphanumeric run becomes one hyphen. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function boundedSlug(value: string): string {
  return slugify(value).slice(0, MAX_SLUG_LENGTH).replace(/-+$/g, "");
}

/** Safe, human-readable download name: title first, path id as the fallback. */
export function exportFilename(
  path: Pick<LearningPath, "id" | "title">,
  format: ExportFormat,
): string {
  const base = boundedSlug(path.title) || boundedSlug(path.id) || "learning-path";
  return `${base}.${format === "json" ? "json" : "md"}`;
}

/** Pretty JSON that round-trips through the authoritative validator. */
export function exportLearningPathAsJson(path: LearningPath): string {
  const parsed = parseLearningPath(path);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function formatCanonicalReference(reference: CanonicalReference): string {
  const details = [
    reference.author === undefined ? undefined : reference.author,
    reference.edition === undefined ? undefined : `edition ${reference.edition}`,
  ].filter((part): part is string => part !== undefined);
  const suffix = details.length === 0 ? "" : ` — ${details.join(" — ")}`;
  return `${reference.title}${suffix} — ${reference.kind}`;
}

function formatUploadedSource(source: UploadedSourceReference): string {
  return `${source.name} (\`${source.sourceId}\`)`;
}

function formatSourceSpine(spine: SourceSpine): string[] {
  if (spine.mode === "canonical") {
    const lines = ["- **Mode:** Canonical references"];
    for (const reference of spine.references) {
      lines.push(`- **Reference:** ${formatCanonicalReference(reference)}`);
    }
    for (const supplement of spine.supplements ?? []) {
      lines.push(`- **Uploaded supplement:** ${formatUploadedSource(supplement)}`);
    }
    return lines;
  }
  const lines = ["- **Mode:** Uploaded corpus"];
  for (const source of spine.sources) {
    lines.push(`- **Source:** ${formatUploadedSource(source)}`);
  }
  for (const supplement of spine.supplements ?? []) {
    lines.push(`- **Canonical supplement:** ${formatCanonicalReference(supplement)}`);
  }
  return lines;
}

function effectiveArtifact(
  path: LearningPath,
  node: PathNode,
  settings?: PluginSettings,
): ArtifactType {
  return (
    node.artifactConfig?.type ??
    path.artifactDefault ??
    settings?.artifactDefaults[node.type] ??
    defaultArtifactFor(node.type)
  );
}

function nodeLines(
  path: LearningPath,
  node: PathNode,
  nodeTitles: ReadonlyMap<string, string>,
  settings?: PluginSettings,
): string[] {
  const lines = [
    `#### ${node.title}`,
    "",
    `- **Type:** ${NODE_TYPE_LABELS[node.type]} · **Progression:** ${PROGRESSION_LABELS[node.progression]} · **ID:** \`${node.id}\``,
    `- **Goal:** ${node.goal}`,
    `- **Source anchor:** ${formatSourceAnchor(node.sourceAnchor)}`,
  ];
  if (node.lightPreReading !== undefined) {
    lines.push(`- **Light pre-reading:** ${node.lightPreReading}`);
  }
  if (node.interleavesNodeIds.length > 0) {
    const interleaves = node.interleavesNodeIds
      .map((id) => `${nodeTitles.get(id) ?? id} (\`${id}\`)`)
      .join(", ");
    lines.push(`- **Interleaves:** ${interleaves}`);
  }

  const artifact = effectiveArtifact(path, node, settings);
  const instructions = node.artifactConfig?.instructions;
  lines.push(
    `- **Artifact:** ${artifactLabel(artifact)}${
      instructions === undefined ? "" : ` — ${instructions}`
    }`,
  );
  if (node.artifactNote !== undefined) {
    lines.push(`- **Artifact note:** ${node.artifactNote}`);
  }

  if (node.childSessions.length > 0) {
    lines.push("- **Child sessions:**");
    for (const chat of node.childSessions) {
      lines.push(
        `  - ${chat.kind === "teaching" ? "Teaching" : "Practice"}: ${chat.label} (\`${chat.chatId}\`)`,
      );
    }
  }

  if (node.errors.length > 0) {
    lines.push("- **Error ledger:**");
    for (const error of node.errors) {
      const notes = error.notes === undefined ? "" : ` — Notes: ${error.notes}`;
      lines.push(
        `  - [${error.resolved ? "x" : " "}] **${ERROR_CATEGORY_LABELS[error.category]}:** ${error.summary}${notes}`,
      );
    }
  }

  if (node.pivotSuggestions.length > 0) {
    lines.push("- **Pivot suggestions:**");
    for (const pivot of node.pivotSuggestions) {
      lines.push(
        `  - [${pivot.status}] **${NODE_TYPE_LABELS[pivot.proposalType]} — ${pivot.title}:** ${pivot.rationale}`,
      );
    }
  }

  return lines;
}

/** The Workspace ledger, newest last: honest inventory of the learner's own
 * material. Note content is appended exactly as stored — the workspace never
 * reformats the learner's writing. */
function workspaceLines(
  items: readonly WorkspaceExportItem[],
  nodeTitles: ReadonlyMap<string, string>,
): string[] {
  const lines = [
    "## Workspace",
    "",
    "The learner's own material for this path, oldest first. Note content is verbatim.",
  ];
  const ordered = [...items].sort((a, b) => a.item.addedAt.localeCompare(b.item.addedAt));
  for (const { item, content } of ordered) {
    lines.push("", `#### ${item.title}`, "");
    lines.push(
      `- **Kind:** ${item.kind} · **Added by:** ${item.addedBy} · **Added at:** ${item.addedAt}`,
    );
    if (item.links.length > 0) {
      lines.push(
        `- **Links:** ${item.links
          .map((link) => `${link.rel} → ${link.to === "space" ? "workspace" : nodeTitles.get(link.to) ?? link.to}`)
          .join(", ")}`,
      );
    }
    if (item.caption !== undefined) {
      lines.push(`- **Caption:** ${item.caption}`);
    }
    if (item.kind === "source") {
      lines.push(`- **Source:** \`${item.sourceId}\` (in the global sources store)`);
    }
    if (content !== null) {
      lines.push("", content.replace(/\n+$/, ""));
    }
  }
  return lines;
}

/** A rich, stable Markdown companion to the JSON export. */
export function exportLearningPathAsMarkdown(
  path: LearningPath,
  settings?: PluginSettings,
  workspace: readonly WorkspaceExportItem[] = [],
): string {
  const parsed = parseLearningPath(path);
  const nodes = parsed.modules.flatMap((module) => module.nodes);
  const nodeTitles = new Map(nodes.map((node) => [node.id, node.title]));
  const consolidated = nodes.filter((node) => node.progression === "consolidated").length;
  const inProgress = nodes.filter((node) => node.progression === "in_progress").length;

  const blocks: string[] = [
    [`# ${parsed.title}`, "", parsed.goal].join("\n"),
    [
      `- **Path ID:** \`${parsed.id}\``,
      `- **Progress:** ${consolidated} of ${nodes.length} nodes consolidated · ${inProgress} in progress`,
      `- **Created:** ${parsed.createdAt}`,
      `- **Updated:** ${parsed.updatedAt}`,
      ...(parsed.tags === undefined || parsed.tags.length === 0
        ? []
        : [`- **Tags:** ${parsed.tags.join(", ")}`]),
      ...(parsed.folder === undefined ? [] : [`- **Folder:** ${parsed.folder}`]),
      ...(parsed.artifactDefault
        ? [`- **Default artifact:** ${artifactLabel(parsed.artifactDefault)}`]
        : []),
    ].join("\n"),
    ["## Source Spine", "", ...formatSourceSpine(parsed.sourceSpine)].join("\n"),
  ];

  const moduleBlocks: string[] = [];
  parsed.modules.forEach((module, index) => {
    const lines = [`### Module ${index + 1}: ${module.title}`];
    if (module.goal !== undefined) lines.push("", module.goal);
    for (const node of module.nodes) {
      lines.push("", ...nodeLines(parsed, node, nodeTitles, settings));
    }
    moduleBlocks.push(lines.join("\n"));
  });
  blocks.push(["## Modules", "", ...moduleBlocks].join("\n\n"));
  if (workspace.length > 0) {
    blocks.push(workspaceLines(workspace, nodeTitles).join("\n"));
  }
  return `${blocks.join("\n\n")}\n`;
}

function assertExportFormat(format: unknown): asserts format is ExportFormat {
  if (typeof format !== "string" || !(EXPORT_FORMATS as readonly string[]).includes(format)) {
    throw new Error(`format must be one of: ${EXPORT_FORMATS.join(", ")}.`);
  }
}

/** Validate once, then render the selected representation with its download metadata. */
export function exportLearningPath(
  path: LearningPath,
  format: ExportFormat,
  settings?: PluginSettings,
  workspace: readonly WorkspaceExportItem[] = [],
): ExportedLearningPath {
  assertExportFormat(format);
  const parsed = parseLearningPath(path);
  return {
    pathId: parsed.id,
    title: parsed.title,
    format,
    filename: exportFilename(parsed, format),
    mimeType: format === "json" ? "application/json" : "text/markdown",
    content:
      format === "json"
        ? exportLearningPathAsJson(parsed)
        : exportLearningPathAsMarkdown(parsed, settings, workspace),
  };
}

/** Hand the exported bytes to the browser through a temporary, self-cleaning anchor. */
export function triggerBrowserDownload(document: Document, exported: ExportedLearningPath): void {
  const anchor = document.createElement("a");
  anchor.className = "lp-export-download";
  anchor.download = exported.filename;
  anchor.dataset.exportFormat = exported.format;
  anchor.dataset.exportFilename = exported.filename;
  anchor.rel = "noopener";

  let objectUrl: string | null = null;
  if (
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    typeof Blob !== "undefined"
  ) {
    objectUrl = URL.createObjectURL(
      new Blob([exported.content], { type: `${exported.mimeType};charset=utf-8` }),
    );
    anchor.href = objectUrl;
  } else {
    anchor.href = `data:${exported.mimeType};charset=utf-8,${encodeURIComponent(exported.content)}`;
  }

  (document.body ?? document.documentElement).append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
  }
}
