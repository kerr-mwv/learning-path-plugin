/** Paths overview — the Path Hub's dashboard surface.
 *
 * One card per learning path with honest inventory: module/node counts, a
 * node-state distribution strip that always carries labels and counts (color
 * never stands alone), pending pivots and unresolved watchpoints. Learner-owned
 * grouping tags file a path under an exam, field or project; a tag filter
 * groups cards client-side, a search box narrows them by title, goal or tag,
 * and tag edits go through `paths.updateMeta`.
 *
 * Each path also has one folder home (`exam/step-2`); a folder picker shows the
 * hierarchy with subtree counts, and cards can be filtered by folder as well as
 * by tag. Folder edits ride the same `paths.updateMeta` dialog.
 *
 * Each card's foot carries filing and removal: a tag glyph opens the tags
 * dialog, a trashcan opens the delete one — the Settings page's same
 * `paths.delete` write, confirmed by a dialog that names exactly what goes
 * (the path record, its workspace, orphaned converted uploads) and what
 * stays (native chats, Knowledge Graph records). A success hands the
 * refetch to the hub, which reselects exactly as for any other change.
 *
 * There is deliberately no scheduling surface here: no dates, hours, streaks
 * or completion percentages. The Architect has no tool that writes tags or
 * folders, so how a path is filed never drifts from what it teaches.
 */
import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import {
  MAX_PATH_FOLDER_SEGMENTS,
  MAX_PATH_FOLDER_SEGMENT_LENGTH,
  MAX_PATH_TAGS,
  MAX_PATH_TAG_LENGTH,
} from "../domain.ts";
import type { PathSummary } from "./path-hub.ts";

/** Trusted SVG markup for the card's icon-only host buttons (24×24
 * lucide-style line art, matching the hub's window-bar icons). */
const cardIcon = (paths: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

/** A tag: the card's one filing affordance. The label stays the accessible
 * name and the title the hover tooltip, so the word is never hidden from
 * hover or a screen reader. */
const TAG_ICON = cardIcon(
  '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5"/>',
);
/** A trashcan: the card's one removal affordance (the Settings page's same
 * RPC; the confirm dialog carries the words). */
const TRASH_ICON = cardIcon(
  '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
);

export interface PathsOverviewOptions {
  /** A card click switches the hub to that path, like the header select. */
  selectPath(pathId: string): void;
  /** Called once after a successful tag save; the hub refetches. */
  tagsChanged(): void;
  /** Called once after a path deletion; the hub refetches (and reselects,
   * exactly as it does for every other paths-changed event). */
  pathsChanged(): void;
}

/** paths.delete answers with what the one write removed — the Settings
 * page's same flow. Native chats and Knowledge Graph records stay untouched. */
interface DeleteResult {
  readonly deleted: boolean;
  readonly removedSources: readonly string[];
  readonly retainedSources: readonly string[];
  readonly preservedChats: number;
}

export interface PathsOverview {
  render(summaries: readonly PathSummary[], selectedPathId: string | null): void;
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

/** linkedom does not reflect `select.value`; read the selected option instead. */
function selectedValue(select: HTMLSelectElement): string {
  return (
    select.value ||
    [...select.options].find((option) => option.selected)?.value ||
    ""
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Distinct tags across all paths, first-seen casing, alphabetical. */
function distinctTags(summaries: readonly PathSummary[]): readonly string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const summary of summaries) {
    for (const tag of summary.tags) {
      const key = tag.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        tags.push(tag);
      }
    }
  }
  return tags.sort((a, b) => a.localeCompare(b));
}

/** The overview shows at most this many path cards at once, with an honest
 * pager between pages. Paging is presentation, not hiding: every path is
 * reachable, and the count line always reports the whole filtered set. */
export const OVERVIEW_PAGE_SIZE = 5;

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
function tagMatches(tag: string, filter: string | null): boolean {
  return filter === null || tag.toLowerCase() === filter.toLowerCase();
}

/** Case-insensitive substring over the summary's title, goal and tags. An
 * empty or whitespace-only query matches every path, so clearing the box is
 * the same as never having searched. */
function pathMatchesSearch(summary: PathSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [summary.title, summary.goal, ...summary.tags].some((text) =>
    text.toLowerCase().includes(needle),
  );
}

/** Sentinel for the picker's `Unfiled` option. A validated folder can never
 * contain a control character, so it cannot collide with a real folder. */
const UNFILED_FOLDER = "\u0000unfiled";

interface FolderOption {
  readonly path: string;
  /** 0 for a top-level folder; children indent under their parent. */
  readonly depth: number;
  /** Paths filed in this folder or any of its subfolders. */
  readonly count: number;
}

/** Every folder (and its ancestors) across paths, as a depth-first hierarchy;
 * ancestor counts include their subtrees so picking a parent is never empty. */
function distinctFolders(summaries: readonly PathSummary[]): readonly FolderOption[] {
  const counts = new Map<string, number>();
  const roots = new Set<string>();
  const children = new Map<string, Set<string>>();
  for (const summary of summaries) {
    if (summary.folder === null) continue;
    const segments = summary.folder.split("/");
    let prefix = "";
    for (const [index, segment] of segments.entries()) {
      const parent = prefix;
      prefix = index === 0 ? segment : `${prefix}/${segment}`;
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
      if (index === 0) {
        roots.add(prefix);
      } else {
        const siblings = children.get(parent) ?? new Set<string>();
        siblings.add(prefix);
        children.set(parent, siblings);
      }
    }
  }
  const options: FolderOption[] = [];
  const walk = (nodes: Iterable<string>, depth: number): void => {
    const sorted = [...nodes].sort((a, b) => folderLabel(a).localeCompare(folderLabel(b)));
    for (const node of sorted) {
      options.push({ path: node, depth, count: counts.get(node) ?? 0 });
      const nested = children.get(node);
      if (nested) walk(nested, depth + 1);
    }
  };
  walk(roots, 0);
  return options;
}

function folderLabel(folder: string): string {
  return folder.split("/").at(-1) ?? folder;
}

/** Choosing a folder shows its subtree; `Unfiled` means absence, not a folder. */
function folderMatches(folder: string | null, filter: string): boolean {
  if (filter === UNFILED_FOLDER) return folder === null;
  return folder !== null && (folder === filter || folder.startsWith(`${filter}/`));
}

/** Parse and locally validate one folder entry. Returns a precise, learner-readable
 * error; the backend re-validates with the same domain rules. */
function parseFolderEntry(raw: string): { folder: string | null; error: string | null } {
  const folder = raw.trim();
  if (folder.length === 0) return { folder: null, error: null };
  const levels = folder.split("/");
  if (levels.length > MAX_PATH_FOLDER_SEGMENTS) {
    return { folder: null, error: `A folder has at most ${MAX_PATH_FOLDER_SEGMENTS} levels.` };
  }
  for (const [index, level] of levels.entries()) {
    if (level.length === 0) {
      return {
        folder: null,
        error: `Folder level ${index + 1} is empty — check for a leading, trailing or doubled "/".`,
      };
    }
    if (level.length > MAX_PATH_FOLDER_SEGMENT_LENGTH) {
      return {
        folder: null,
        error: `Folder level ${index + 1} is at most ${MAX_PATH_FOLDER_SEGMENT_LENGTH} characters.`,
      };
    }
    if (level !== level.trim()) {
      return { folder: null, error: `Folder level ${index + 1} must not start or end with a space.` };
    }
  }
  return { folder, error: null };
}

/** The only orderings the overview offers. Neither implies priority: there is
 * no "smart" order and no notion of a path being stale. */
type SortKey = "updated" | "title";

const DEFAULT_SORT: SortKey = "updated";

const SORT_OPTIONS: readonly { readonly value: SortKey; readonly label: string }[] = [
  { value: "updated", label: "Recently updated" },
  { value: "title", label: "Title A–Z" },
];

function updatedTime(summary: PathSummary): number {
  const time = Date.parse(summary.updatedAt);
  return Number.isNaN(time) ? 0 : time;
}

/** Deterministic under either key: ties fall through to title, then id, so the
 * order never depends on the order `paths.list` happened to return. */
function inSortOrder(summaries: readonly PathSummary[], sort: SortKey): PathSummary[] {
  return [...summaries].sort((a, b) => {
    if (sort === "updated") {
      const byUpdated = updatedTime(b) - updatedTime(a);
      if (byUpdated !== 0) return byUpdated;
    }
    const byTitle = a.title.localeCompare(b.title);
    return byTitle !== 0 ? byTitle : a.id.localeCompare(b.id);
  });
}

/** Paths per tag, keyed lowercase so casing never splits a group. A path counts
 * once per tag even if the record repeats it. */
function tagCounts(summaries: readonly PathSummary[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const summary of summaries) {
    const seen = new Set<string>();
    for (const tag of summary.tags) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

/** Parse and locally validate a comma-separated tag entry. Returns precise
 * learner-readable errors; the backend re-validates with the same domain rules. */
function parseTagEntry(raw: string): { tags: readonly string[]; error: string | null } {
  const tags = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (tags.length > MAX_PATH_TAGS) {
    return { tags, error: `A path carries at most ${MAX_PATH_TAGS} tags.` };
  }
  for (const tag of tags) {
    if (tag.length > MAX_PATH_TAG_LENGTH) {
      return { tags, error: `Each tag is at most ${MAX_PATH_TAG_LENGTH} characters.` };
    }
  }
  const seen = new Set<string>();
  for (const tag of tags) {
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      return { tags, error: `Duplicate tag "${tag}" — tags ignore letter case.` };
    }
    seen.add(key);
  }
  return { tags, error: null };
}

export function createPathsOverview(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: PathsOverviewOptions,
): PathsOverview {
  const document = container.ownerDocument;
  const root = element(document, "div", "lp-overview");
  root.setAttribute("aria-label", "Paths overview");
  container.append(root);

  let cardHandles: PluginWidgetHandle<unknown>[] = [];
  let disposed = false;
  let filterTag: string | null = null;
  let searchQuery = "";
  let pageNumber = 0;
  let resultsSignature = "";

  /** "" means all paths, `UNFILED_FOLDER` means unfiled, else a folder subtree. */
  let filterFolder = "";

  let sortKey: SortKey = DEFAULT_SORT;
  let latestSummaries: readonly PathSummary[] = [];
  let cardsHost: HTMLElement | null = null;
  let countHost: HTMLElement | null = null;
  let pagerHost: HTMLElement | null = null;

  const clearCards = (): void => {
    for (const handle of cardHandles.reverse()) handle.dispose();
    cardHandles = [];
  };

  const clear = (): void => {
    clearCards();
    cardsHost = null;
    countHost = null;
    root.replaceChildren();
  };

  const badge = (parent: HTMLElement, text: string, color: string): void => {
    const host = element(document, "span", "lp-badge-host");
    parent.append(host);
    cardHandles.push(ctx.ui.mountBadge(host, { text, color }, { signal }));
  };

  const button = (
    parent: HTMLElement,
    label: string,
    onClick: () => void,
    extra: {
      variant?: "default" | "link" | "outline" | "ghost" | "secondary";
      size?: "xs" | "sm";
      title?: string;
      icon?: string;
      iconOnly?: boolean;
    } = {},
  ): void => {
    const host = element(document, "span", "lp-button-host");
    parent.append(host);
    cardHandles.push(
      ctx.ui.mountButton(
        host,
        {
          label,
          variant: extra.variant ?? "outline",
          size: extra.size ?? "xs",
          ...(extra.title === undefined ? {} : { title: extra.title }),
          ...(extra.icon === undefined ? {} : { icon: extra.icon }),
          ...(extra.iconOnly === undefined ? {} : { iconOnly: extra.iconOnly }),
          onClick: () => {
            if (!signal.aborted && !disposed) onClick();
          },
        },
        { signal },
      ),
    );
  };

  /** Deleting a path is the Settings page's same one write (`paths.delete`):
   * only plugin-owned records go — the path, its workspace and orphaned
   * converted uploads. The dialog names exactly what leaves and what stays
   * (native chats and Knowledge Graph records are never touched), a
   * failure stays in the dialog, and a success hands the refetch to the hub. */
  function openDeleteDialog(summary: PathSummary): void {
    if (disposed || signal.aborted) return;
    let dialog: PluginWidgetHandle<never> | null = null;
    const close = (): void => {
      const current = dialog;
      dialog = null;
      current?.dispose();
    };

    dialog = ctx.ui.openDialog(
      {
        title: `Delete the learning path "${summary.title}"?`,
        content: (contentContainer: HTMLElement, contentSignal: AbortSignal) => {
          const doc = contentContainer.ownerDocument;
          const dialogRoot = element(doc, "div", "lp-delete-dialog");
          dialogRoot.append(element(doc, "h2", "lp-dialog-title", summary.title));
          dialogRoot.append(
            element(
              doc,
              "p",
              "lp-dialog-text",
              `This deletes the plugin's path record (${summary.moduleCount} module(s), ${summary.nodeCount} node(s)), ` +
                "its workspace and any converted source files no other path uses.",
            ),
          );
          dialogRoot.append(
            element(
              doc,
              "p",
              "lp-dialog-text lp-dialog-safe",
              "Native LearnHarness chats and Knowledge Graph records are never deleted by this action.",
            ),
          );
          const error = element(doc, "p", "lp-dialog-error");
          error.setAttribute("role", "alert");
          error.hidden = true;
          dialogRoot.append(error);
          const actions = element(doc, "div", "lp-dialog-actions");
          dialogRoot.append(actions);
          contentContainer.append(dialogRoot);

          const keepHost = element(doc, "span", "lp-button-host");
          actions.append(keepHost);
          ctx.ui.mountButton(
            keepHost,
            {
              label: "Keep path",
              variant: "outline",
              size: "sm",
              onClick: () => close(),
            },
            { signal: contentSignal },
          );

          const deleteHost = element(doc, "span", "lp-button-host");
          actions.append(deleteHost);
          const remove = ctx.ui.mountButton(
            deleteHost,
            {
              label: "Delete path",
              variant: "destructive",
              size: "sm",
              onClick: async () => {
                if (contentSignal.aborted || disposed || signal.aborted) return;
                error.hidden = true;
                remove.update({ disabled: true, label: "Deleting…" });
                try {
                  await ctx.call<DeleteResult>("paths.delete", { pathId: summary.id });
                  if (contentSignal.aborted || disposed || signal.aborted) return;
                  close();
                  options.pathsChanged();
                } catch (problem) {
                  if (contentSignal.aborted || disposed || signal.aborted) return;
                  error.textContent = `Could not delete "${summary.title}": ${describeError(problem)}`;
                  error.hidden = false;
                  remove.update({ disabled: false, label: "Delete path" });
                }
              },
            },
            { signal: contentSignal },
          );
        },
      },
      { signal },
    ) as PluginWidgetHandle<never>;
  }

  /** Tags are learner filing. The dialog is the only writer, and it saves
   * through `paths.updateMeta`, never through the Architect conversation. */
  function openTagsDialog(summary: PathSummary): void {
    if (disposed || signal.aborted) return;
    let dialog: PluginWidgetHandle<never> | null = null;
    const close = (): void => {
      const current = dialog;
      dialog = null;
      current?.dispose();
    };

    dialog = ctx.ui.openDialog(
      {
        title: `Edit tags — ${summary.title}`,
        content: (contentContainer: HTMLElement, contentSignal: AbortSignal) => {
          const doc = contentContainer.ownerDocument;
          const dialogRoot = element(doc, "div", "lp-tags-dialog");
          dialogRoot.append(
            element(
              doc,
              "p",
              "lp-muted",
              "Group this path with tags and give it one folder home. Tags are cross-cutting; the folder is where the path lives. Filing only, never scheduling.",
            ),
          );
          const field = element(doc, "label", "lp-field");
          field.append(element(doc, "span", "lp-field-label", "Tags"));
          const input = doc.createElement("input");
          input.className = "lp-input lp-tags-input";
          input.setAttribute("type", "text");
          input.setAttribute("aria-label", "Tags, comma-separated");
          input.value = summary.tags.join(", ");
          field.append(input);
          dialogRoot.append(field);

          const folderField = element(doc, "label", "lp-field");
          folderField.append(element(doc, "span", "lp-field-label", "Folder"));
          const folderInput = doc.createElement("input");
          folderInput.className = "lp-input lp-folder-input";
          folderInput.setAttribute("type", "text");
          folderInput.setAttribute("aria-label", "Folder, e.g. exam/step-2");
          folderInput.setAttribute("placeholder", "e.g. exam/step-2 — leave empty for unfiled");
          folderInput.value = summary.folder ?? "";
          folderField.append(folderInput);
          dialogRoot.append(folderField);
          const status = element(doc, "p", "lp-dialog-status");
          status.setAttribute("role", "status");
          const error = element(doc, "p", "lp-dialog-error");
          error.setAttribute("role", "alert");
          error.hidden = true;
          dialogRoot.append(status, error);
          const actions = element(doc, "div", "lp-dialog-actions");
          dialogRoot.append(actions);
          contentContainer.append(dialogRoot);

          const dialogHandles: PluginWidgetHandle<unknown>[] = [];
          let saving = false;

          const saveTags = async (): Promise<void> => {
            if (contentSignal.aborted || signal.aborted || saving) return;
            const parsedTags = parseTagEntry(input.value);
            const parsedFolder = parseFolderEntry(folderInput.value);
            const invalid = parsedTags.error ?? parsedFolder.error;
            if (invalid !== null) {
              status.textContent = "";
              error.textContent = invalid;
              error.hidden = false;
              return;
            }
            saving = true;
            try {
              // Folder is only sent when it changed; omitted leaves it alone, so
              // the dialog works against backends that predate the field.
              const update: { pathId: string; tags: readonly string[]; folder?: string | null } = {
                pathId: summary.id,
                tags: parsedTags.tags,
              };
              if ((parsedFolder.folder ?? "") !== (summary.folder ?? "")) {
                update.folder = parsedFolder.folder;
              }
              await ctx.call("paths.updateMeta", update);
              if (contentSignal.aborted || signal.aborted) return;
              status.textContent = "Filing saved.";
              options.tagsChanged();
              close();
            } catch (problem) {
              status.textContent = "";
              error.textContent = describeError(problem);
              error.hidden = false;
            } finally {
              saving = false;
            }
          };

          dialogHandles.push(
            ctx.ui.mountButton(
              actions,
              {
                label: "Save tags",
                variant: "default",
                size: "sm",
                onClick: () => {
                  void saveTags();
                },
              },
              { signal: contentSignal },
            ),
          );

          return () => {
            for (const handle of dialogHandles.reverse()) handle.dispose();
            dialogHandles.length = 0;
            dialogRoot.remove();
          };
        },
        onClose: close,
      },
      { signal },
    );
  }

  function card(summary: PathSummary, selected: boolean): void {
    const cards = root.querySelector<HTMLElement>(".lp-overview-cards");
    if (!cards) return;
    const cardRoot = element(document, "article", "lp-path-card");
    cardRoot.setAttribute("data-path-id", summary.id);
    if (selected) cardRoot.classList.add("lp-path-card-selected");
    if (
      summary.tags.some((tag) => tagMatches(tag, filterTag)) &&
      (filterFolder === "" || folderMatches(summary.folder, filterFolder))
    ) {
      cardRoot.classList.add("lp-path-card-filtered-in");
    }

    const header = element(document, "header", "lp-path-card-header");
    button(header, summary.title, () => options.selectPath(summary.id), { variant: "link", size: "sm" });
    cardRoot.append(header);

    // The whole card selects the path; the title button stays the accessible
    // control. Clicks landing on a card's own buttons keep their own action.
    cardRoot.addEventListener("click", (event) => {
      if (disposed || signal.aborted) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest(".lp-button-host")) return;
      options.selectPath(summary.id);
    });

    cardRoot.append(element(document, "p", "lp-path-card-goal", summary.goal));
    cardRoot.append(
      element(
        document,
        "p",
        "lp-muted",
        `${summary.sourceMode === "canonical" ? "Canonical" : "Uploaded"} · ${summary.sourceTitles.join(", ")}`,
      ),
    );
    cardRoot.append(
      element(
        document,
        "p",
        "lp-muted",
        `${countLabel(summary.moduleCount, "module")} · ${countLabel(summary.nodeCount, "node")}`,
      ),
    );

    // Honest inventory: the strip always ships with its labeled counts, so the
    // meaning never rides on color alone.
    const states = summary.nodeStates;
    const total = states.unstarted + states.in_progress + states.consolidated;
    const distributionText = `${states.consolidated} consolidated · ${states.in_progress} in progress · ${states.unstarted} unstarted`;
    const strip = element(document, "div", "lp-distribution");
    strip.setAttribute("role", "img");
    strip.setAttribute("aria-label", distributionText);
    for (const state of ["consolidated", "in_progress", "unstarted"] as const) {
      const segment = element(document, "span", `lp-distribution-segment lp-distribution-${state}`);
      segment.style.flexGrow = total === 0 ? "1" : String(states[state]);
      strip.append(segment);
    }
    cardRoot.append(strip, element(document, "p", "lp-muted", distributionText));

    if (summary.pendingPivotCount > 0 || summary.unresolvedErrorCount > 0) {
      const badges = element(document, "div", "lp-badge-row");
      if (summary.pendingPivotCount > 0) {
        badge(badges, countLabel(summary.pendingPivotCount, "pending pivot"), "var(--chart-3, #f59e0b)");
      }
      if (summary.unresolvedErrorCount > 0) {
        badge(badges, countLabel(summary.unresolvedErrorCount, "unresolved error"), "var(--chart-6, #ef4444)");
      }
      cardRoot.append(badges);
    }

    if (summary.folder !== null) {
      cardRoot.append(element(document, "p", "lp-muted lp-path-card-folder", `Folder: ${summary.folder}`));
    }

    if (summary.tags.length > 0) {
      const row = element(document, "div", "lp-tag-row");
      for (const tag of summary.tags) {
        row.append(element(document, "span", "lp-tag", tag));
      }
      cardRoot.append(row);
    }

    // Filing and removal live at the card's foot: a tag glyph opens the tags
    // dialog, a trashcan opens the delete one. Icon-only, like the ledger's
    // row actions — the label stays the accessible name and the hover title
    // carries the words.
    const footer = element(document, "div", "lp-path-card-footer");
    button(footer, "Edit tags", () => openTagsDialog(summary), {
      variant: "outline",
      size: "xs",
      title: `Edit tags — ${summary.title}`,
      icon: TAG_ICON,
      iconOnly: true,
    });
    button(footer, "Delete path", () => openDeleteDialog(summary), {
      variant: "ghost",
      size: "xs",
      title: `Delete ${summary.title}`,
      icon: TRASH_ICON,
      iconOnly: true,
    });
    cardRoot.append(footer);

    cards.append(cardRoot);
  }

  /** One sentence that names what to clear, so an empty result is a state the
   * learner can leave rather than a dead grid. */
  function emptyMessage(): string {
    const term = searchQuery.trim();
    const alsoTag = filterTag === null ? "" : " and the group filter";
    const alsoFolder = filterFolder === "" ? "" : " and the folder filter";
    if (term !== "") {
      return `No paths match "${term}". Clear the search${alsoTag}${alsoFolder} to see them all.`;
    }
    if (filterTag !== null && filterFolder !== "") {
      return "No paths match both the folder and tag filters. Clear one to see them all.";
    }
    if (filterFolder !== "") {
      return filterFolder === UNFILED_FOLDER
        ? "No unfiled paths. Clear the folder filter to see them all."
        : "No paths are filed in this folder. Clear the folder filter to see them all.";
    }
    if (filterTag !== null) {
      return "No paths carry this tag. Clear the group filter to see them all.";
    }
    return "No paths match.";
  }

  /** Rebuild only the results region, so typing keeps focus and caret. */
  function renderResults(selectedPathId: string | null): void {
    const cards = cardsHost;
    const count = countHost;
    if (disposed || signal.aborted || !cards || !count) return;
    clearCards();
    cards.replaceChildren();

    // The same filtered set drives the count, the sort and the grid, so the
    // line can never disagree with what is on screen.
    const visible = inSortOrder(
      latestSummaries.filter(
        (summary) =>
          (filterTag === null || summary.tags.some((tag) => tagMatches(tag, filterTag))) &&
          (filterFolder === "" || folderMatches(summary.folder, filterFolder)) &&
          pathMatchesSearch(summary, searchQuery),
      ),
      sortKey,
    );
    count.textContent = `${visible.length} of ${latestSummaries.length} paths`;
    if (visible.length === 0 && latestSummaries.length > 0) {
      pagerHost?.replaceChildren();
      cards.append(element(document, "p", "lp-empty-state", emptyMessage()));
      return;
    }

    // A changed search, tag, folder or sort restarts at the first page; a
    // shrunken result set clamps the held page into range.
    const signature = `${filterTag ?? ""}\u0000${filterFolder}\u0000${searchQuery.trim().toLowerCase()}\u0000${sortKey}`;
    if (signature !== resultsSignature) {
      resultsSignature = signature;
      pageNumber = 0;
    }
    const pageCount = Math.max(1, Math.ceil(visible.length / OVERVIEW_PAGE_SIZE));
    if (pageNumber >= pageCount) pageNumber = pageCount - 1;
    const page = visible.slice(
      pageNumber * OVERVIEW_PAGE_SIZE,
      (pageNumber + 1) * OVERVIEW_PAGE_SIZE,
    );
    for (const summary of page) {
      card(summary, summary.id === selectedPathId);
    }

    const pager = pagerHost;
    pager?.replaceChildren();
    if (pager && pageCount > 1) {
      const previous = ctx.ui.mountButton(
        pager,
        {
          label: "Previous",
          variant: "outline",
          size: "xs",
          disabled: pageNumber === 0,
          onClick: () => {
            if (disposed || signal.aborted) return;
            pageNumber = Math.max(0, pageNumber - 1);
            renderResults(selectedPathId);
          },
        },
        { signal },
      );
      cardHandles.push(previous);
      pager.append(
        element(document, "span", "lp-muted lp-overview-pager-status", `Page ${pageNumber + 1} of ${pageCount}`),
      );
      const next = ctx.ui.mountButton(
        pager,
        {
          label: "Next",
          variant: "outline",
          size: "xs",
          disabled: pageNumber >= pageCount - 1,
          onClick: () => {
            if (disposed || signal.aborted) return;
            pageNumber = Math.min(pageCount - 1, pageNumber + 1);
            renderResults(selectedPathId);
          },
        },
        { signal },
      );
      cardHandles.push(next);
    }
  }

  function render(summaries: readonly PathSummary[], selectedPathId: string | null): void {
    if (disposed || signal.aborted) return;
    latestSummaries = summaries;
    clear();

    root.append(element(document, "h2", "lp-pane-title", "Paths overview"));

    const controls = element(document, "div", "lp-overview-controls");
    // The box exists exactly when there is something to search.
    if (summaries.length > 0) {
      const field = element(document, "label", "lp-path-field lp-overview-search");
      field.append(element(document, "span", "lp-field-label", "Search"));
      const input = element(document, "input", "lp-input lp-search-input");
      input.setAttribute("type", "text");
      input.setAttribute("aria-label", "Search paths");
      input.setAttribute("placeholder", "Title, goal or tag");
      input.value = searchQuery;
      input.addEventListener("input", () => {
        if (disposed || signal.aborted) return;
        searchQuery = input.value;
        renderResults(selectedPathId);
      });
      field.append(input);
      controls.append(field);
    }
    const folderOptions = distinctFolders(summaries);
    // A held folder filter survives the last path leaving it: keep the option
    // listed so the empty result can be cleared, never silently fall back.
    const heldFolder =
      filterFolder === "" ||
      filterFolder === UNFILED_FOLDER ||
      folderOptions.some((option) => option.path === filterFolder)
        ? null
        : filterFolder;
    const unfiledCount = summaries.filter((summary) => summary.folder === null).length;
    const folderField = element(document, "label", "lp-path-field");
    folderField.append(element(document, "span", "lp-field-label", "Folder"));
    const folderSelect = element(document, "select", "lp-select lp-overview-folder");
    folderSelect.setAttribute("aria-label", "Filter paths by folder");
    const allFolders = element(document, "option", undefined, `All paths (${summaries.length})`);
    allFolders.value = "";
    folderSelect.append(allFolders);
    const unfiled = element(document, "option", undefined, `Unfiled (${unfiledCount})`);
    unfiled.value = UNFILED_FOLDER;
    folderSelect.append(unfiled);
    const addFolderOption = (path: string, depth: number, count: number): void => {
      const option = element(
        document,
        "option",
        undefined,
        `${"\u00a0".repeat(depth * 3)}${folderLabel(path)} (${count})`,
      );
      option.value = path;
      folderSelect.append(option);
    };
    for (const option of folderOptions) addFolderOption(option.path, option.depth, option.count);
    if (heldFolder !== null) addFolderOption(heldFolder, 0, 0);
    if (filterFolder !== "") {
      const option = [...folderSelect.options].find((candidate) => candidate.value === filterFolder);
      if (option) option.selected = true;
    }
    folderSelect.addEventListener("change", () => {
      if (disposed || signal.aborted) return;
      filterFolder = selectedValue(folderSelect);
      renderResults(selectedPathId);
    });
    folderField.append(folderSelect);
    controls.append(folderField);

    const tags = distinctTags(summaries);
    const counts = tagCounts(summaries);

    // A held filter survives a path losing its last instance of the tag: the
    // option stays listed so the empty result can be cleared, never hidden.
    const optionTags =
      filterTag !== null && !tags.some((tag) => tagMatches(tag, filterTag))
        ? [...tags, filterTag]
        : tags;
    if (optionTags.length > 0) {
      const field = element(document, "label", "lp-path-field");
      field.append(element(document, "span", "lp-field-label", "Group"));
      const filterSelect = element(document, "select", "lp-select lp-overview-filter");
      filterSelect.setAttribute("aria-label", "Filter paths by tag");
      const all = element(document, "option", undefined, `All paths (${summaries.length})`);
      all.value = "";
      filterSelect.append(all);
      for (const tag of optionTags) {
        const count = counts.get(tag.toLowerCase()) ?? 0;
        const option = element(document, "option", undefined, `${tag} (${count})`);
        option.value = tag;
        filterSelect.append(option);
      }
      if (filterTag !== null) {
        const option = [...filterSelect.options].find((candidate) => candidate.value === filterTag);
        if (option) option.selected = true;
      }
      filterSelect.addEventListener("change", () => {
        if (disposed || signal.aborted) return;
        const value = selectedValue(filterSelect);
        filterTag = value === "" ? null : value;
        renderResults(selectedPathId);
      });
      field.append(filterSelect);
      controls.append(field);
    }
    const sortField = element(document, "label", "lp-path-field");
    sortField.append(element(document, "span", "lp-field-label", "Sort"));
    const sortSelect = element(document, "select", "lp-select lp-overview-sort");
    sortSelect.setAttribute("aria-label", "Sort paths");
    for (const candidate of SORT_OPTIONS) {
      const option = element(document, "option", undefined, candidate.label);
      option.value = candidate.value;
      if (candidate.value === sortKey) option.selected = true;
      sortSelect.append(option);
    }
    sortSelect.addEventListener("change", () => {
      if (disposed || signal.aborted) return;
      const chosen = SORT_OPTIONS.find((candidate) => candidate.value === selectedValue(sortSelect));
      if (!chosen) return;
      sortKey = chosen.value;
      renderResults(selectedPathId);
    });
    sortField.append(sortSelect);
    controls.append(sortField);
    if (controls.childElementCount > 0) root.append(controls);

    countHost = element(document, "p", "lp-muted lp-overview-count");
    countHost.setAttribute("aria-live", "polite");
    root.append(countHost);

    cardsHost = element(document, "div", "lp-overview-cards");
    root.append(cardsHost);
    pagerHost = element(document, "div", "lp-overview-pager");
    root.append(pagerHost);
    renderResults(selectedPathId);
  }

  return {
    render,
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      root.remove();
    },
  };
}
