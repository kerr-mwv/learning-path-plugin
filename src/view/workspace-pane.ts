/** Learning Path — the Workspace ledger pane.
 *
 * The workspace ledger, mounted as the Workspace tab of the Path Hub's
 * floating details window — the same window, the same treatment as the node
 * details (pinned under the header, drag-resized, expanded, closed; see
 * docs/proposals/workspace-manifest.md, "Live-review overrides"). The pane is
 * one flat, navigational inventory of the learner's own material for one path:
 * metadata only, newest last, an honest item count. The guardrails are
 * binding: no unread counts, no "new" badges, and no scheduling semantics of
 * any kind — the ledger records what exists, never what is owed.
 *
 * The list itself is the host tree (`ctx.ui.mountTree`): the host owns rows,
 * columns, keyboard navigation and virtualization, and the pane only supplies
 * controlled rows. Content is lazy: the tree lists titles only, and an item's
 * Markdown body is fetched through `workspace.readItem` (read-only, bounded)
 * only when the learner expands the row's in-place preview. A `source` item
 * references the global sources store and carries no content file, so its
 * preview says so without fetching anything.
 *
 * Multi-node filing: a note is created unlinked or linked to several nodes at
 * once, and any item's links are edited from the pane through a node picker
 * (rel `informs` for new links, existing relations preserved) via the existing
 * `workspace.updateItemMeta` links array.
 *
 * Filing documents: the pane carries one visible filing strip — the only
 * drop target anywhere in the pane — with a native "select from computer…"
 * picker beside it, so drag-and-drop and picking are one affordance and a
 * drop aimed at the path surfaces behind the floating pane is never hijacked.
 * Delivered files are converted through `ctx.documents.toMarkdown` (the
 * Architect pane's pipeline) and filed as node-linked `source` items (rel
 * `grounds`) through one learner write, `workspace.saveSource`. The manifest
 * entry references the global source library's id; content is never copied
 * into the workspace.
 *
 * Reading: item kinds render as small icons (hover carries the word), and an
 * expanded row previews its body in place — the note never leaves the list, so
 * there is no separate viewer to reposition and no fullscreen toggle to break
 * hit targets; the window's own Expand gives the ledger its big reading
 * surface, exactly as it does the details. The pane header carries Open
 * folder (revealing the path's workspace directory through
 * `workspace.openDirectory`) beside Add Note. An item that owns a content
 * file can also leave the list entirely: Open in editor hands the file to the
 * OS, which opens the learner's chosen application (prompting for one where
 * no default exists) — the harness never pretends to be an editor, and the
 * frontmatter keeps an external edit resyncable.
 *
 * Learner-only writes. Agents never create, edit, link or delete learner
 * items. Everything rendered here is controlled by the caller (path, node and
 * workspace after each refetch) and every widget belongs to the per-mount
 * signal.
 */
import type {
  PluginFrontendContext,
  PluginTreeContent,
  PluginTreeProps,
  PluginTreeRow,
  PluginWidgetHandle,
} from "learnharness-plugin-api";
import type {
  LearningPath,
  PathNode,
  WorkspaceItem,
  WorkspaceItemLink,
  WorkspaceManifest,
} from "../domain.ts";
import { WORKSPACE_ITEM_KINDS } from "../domain.ts";

export interface AddNoteInput {
  readonly title: string;
  readonly markdown: string;
  /** Node links filed with the note; empty means the note starts unlinked. */
  readonly links: readonly WorkspaceItemLink[];
}

export interface AddSourceInput {
  /** The converted document's name and Markdown (already through the global
   * conversion pipeline; the backend stores it once, hash-deduplicated). */
  readonly name: string;
  readonly markdown: string;
  /** Node links filed with the document (rel `grounds`). */
  readonly links: readonly WorkspaceItemLink[];
}

/** Documents file as `grounds`: source material a node's understanding stands
 * on. Notes keep the learner's `informs` filing; one rel per material kind. */
export const DOCUMENT_LINK_REL = "grounds";

/** The file types the conversion pipeline accepts, shared with the Architect
 * pane's picker: PDFs and UTF-8 text/markdown documents. */
export const UPLOAD_ACCEPT_TYPES = ".pdf,.md,.markdown,.txt,.text,application/pdf,text/plain,text/markdown";

/** True when a dropped file is one the conversion pipeline can take. */
export function isConvertibleFile(file: { name: string; type?: string }): boolean {
  const type = file.type ?? "";
  if (type === "application/pdf" || type === "text/plain" || type === "text/markdown") return true;
  return /\.(pdf|md|markdown|txt|text)$/i.test(file.name);
}

export interface WorkspacePaneOptions {
  /** Persist a new note through the plugin backend (workspace.saveNote). */
  saveNote(input: AddNoteInput): void | Promise<void>;
  /** Store a converted document in the global source library and file it as a
   * node-linked source item (workspace.saveSource: one learner write). */
  saveSource(input: AddSourceInput): void | Promise<void>;
  /** Replace one item's whole links array (learner filing). */
  setItemLinks(itemId: string, links: readonly WorkspaceItemLink[]): void | Promise<void>;
  /** Delete one workspace item and its content file. */
  deleteItem(itemId: string): void | Promise<void>;
  /** Lazy content read (workspace.readItem): resolved only when the learner
   * opens an item. Null content means the item carries no file (a source). */
  readItem(itemId: string): Promise<string | null>;
  /** Reveal the path's workspace folder in the OS file manager
   * (workspace.openDirectory). */
  openDirectory(): void | Promise<void>;
  /** Open one item's content file outside the harness
   * (workspace.openItem): the OS resolves the application — prompting the
   * learner to pick one wherever no default is registered. */
  openItem(itemId: string): void | Promise<void>;
}

export interface WorkspacePane {
  render(path: LearningPath | null, node: PathNode | null, workspace: WorkspaceManifest | null): void;
  dispose(): void;
}

const KIND_LABELS: Readonly<Record<WorkspaceItem["kind"], string>> = {
  note: "Note",
  session_artifact: "Session artifact",
  source: "Source",
  code: "Code",
};

/** One stroke-drawn glyph per item kind (24×24, lucide-style line art). The
 * label is the hover tooltip and the accessible name, so the ledger rows stay
 * scannable while nothing is hidden from hover or a screen reader. */
const KIND_ICON_PATHS: Readonly<Record<WorkspaceItem["kind"], readonly string[]>> = {
  // A pencil: the learner's own writing.
  note: ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"],
  // A medal: something a session produced and saved. Ribbon tails up top,
  // the disc below — the way a worn medal hangs.
  session_artifact: ["M12 10a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z", "m9.5 10.8-2-8.8 4.5 2.7 4.5-2.7-2 8.8"],
  // A document with text lines: converted material.
  source: ["M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z", "M14 2v6h6", "M16 13H8", "M16 17H8"],
  // A terminal prompt: code the learner wrote.
  code: ["m16 18 6-6-6-6", "m8 6-6 6 6 6", "M12 19h8"],
};

/** A plus: the header's one affordance for adding a note. */
const PLUS_ICON_PATHS = ["M5 12h14", "M12 5v14"] as const;
/** An open folder: reveals the workspace directory in the OS file manager. */
const FOLDER_OPEN_ICON_PATHS = [
  "m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.51l-1.55 6a2 2 0 0 1-1.94 1.49H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2",
] as const;
/** A chain link: filing an item under the path's nodes. */
const LINK_ICON_PATHS = [
  "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
  "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
] as const;
/** A trashcan: removing one item from the ledger. */
const TRASH_ICON_PATHS = [
  "M3 6h18",
  "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
  "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  "M10 11v6",
  "M14 11v6",
] as const;
/** An outbound arrow: handing the item's file to the learner's own editor. */
const OPEN_EDITOR_ICON_PATHS = [
  "M15 3h6v6",
  "M10 14 21 3",
  "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6",
] as const;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** A small inline stroke icon; currentColor keeps it on the palette. */
function svgIcon(document: Document, paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg") as SVGSVGElement;
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  for (const data of paths) {
    const line = document.createElementNS(SVG_NAMESPACE, "path");
    line.setAttribute("d", data);
    svg.append(line);
  }
  return svg;
}

/** The kind shown as its icon; hover (title) and screen readers read the label. */
function kindIcon(document: Document, kind: WorkspaceItem["kind"]): HTMLElement {
  const label = KIND_LABELS[kind] ?? kind;
  const host = element(document, "span", "lp-kind-icon");
  host.title = label;
  host.setAttribute("role", "img");
  host.setAttribute("aria-label", label);
  host.append(svgIcon(document, KIND_ICON_PATHS[kind] ?? []));
  return host;
}

/** The rel learner filing uses for v1 (see docs/proposals/workspace-manifest.md). */
export const LEARNER_LINK_REL = "informs";

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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWorkspacePane(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
  options: WorkspacePaneOptions,
): WorkspacePane {
  const document = container.ownerDocument;
  let disposed = false;
  let handles: PluginWidgetHandle<unknown>[] = [];
  /** Dialog handles live outside `container`, so they are tracked separately. */
  let dialogHandles: PluginWidgetHandle<unknown>[] = [];

  /** Preview state survives refetch-re-renders, so an expanded row stays
   * expanded with its already-fetched content instead of re-reading on every
   * refresh. The cache holds null for an item that carries no content file. */
  const expandedItemIds = new Set<string>();
  const previewCache = new Map<string, string | null>();
  const previewErrors = new Map<string, string>();
  /** The mounted ledger tree. Disclosure toggles and landed reads update the
   * rows in place through this handle, so other expanded previews and their
   * content mounts survive without a remount. */
  let ledgerTree: PluginWidgetHandle<PluginTreeProps> | null = null;

  const clear = (): void => {
    ledgerTree = null;
    for (const handle of handles.reverse()) handle.dispose();
    handles = [];
    container.replaceChildren();
  };

  /** Native DOM button: the pane is a hub layout column whose rows and
   * previews reflow freely; host widgets are kept only where the host owns
   * positioning (the window bar and dialogs). With `icon` the button is
   * icon-only — the label stays the accessible name (aria-label) and the
   * hover title carries the word. */
  const nativeButton = (
    parent: HTMLElement,
    label: string,
    onClick: () => void,
    extra: {
      variant?: "default" | "link" | "outline" | "ghost" | "secondary";
      size?: "xs" | "sm";
      title?: string;
      icon?: readonly string[];
    } = {},
  ): HTMLButtonElement => {
    const classes = ["lp-btn", `lp-btn-${extra.variant ?? "outline"}`];
    if (extra.size) classes.push(`lp-btn-${extra.size}`);
    if (extra.icon) classes.push("lp-btn-icon");
    const btn = document.createElement("button");
    btn.className = classes.join(" ");
    btn.type = "button";
    if (extra.icon) {
      btn.setAttribute("aria-label", label);
      btn.title = extra.title ?? label;
      btn.append(svgIcon(document, extra.icon));
    } else {
      btn.textContent = label;
      if (extra.title) btn.title = extra.title;
    }
    btn.addEventListener("click", () => {
      if (!signal.aborted && !disposed) onClick();
    });
    parent.append(btn);
    return btn;
  };

  // The picker is the one filing surface: checkboxes, not drag order, never
  // progression. Exported so the Architect pane's upload dialog files identically.
  const buildPicker = (
    dialogDocument: Document,
    path: LearningPath,
    checkedNodeIds: ReadonlySet<string>,
  ): { root: HTMLElement; checked(): string[] } =>
    buildNodePicker(dialogDocument, path, checkedNodeIds);

  /** Add-note dialog: title, Markdown body, and a node picker defaulting to the
   * inspected node. An empty picker saves an unlinked note. */
  function openAddNoteDialog(path: LearningPath, node: PathNode | null): void {
    if (signal.aborted || disposed) return;
    let dialog: PluginWidgetHandle<never> | null = null;
    const close = (): void => {
      const current = dialog;
      dialog = null;
      current?.dispose();
    };
    dialog = ctx.ui.openDialog(
      {
        title: "Add Workspace Note",
        content: (content: HTMLElement, contentSignal: AbortSignal): (() => void) | undefined => {
          const dialogDocument = content.ownerDocument;
          const root = element(dialogDocument, "div", "lp-workspace-note-dialog");
          root.append(
            element(
              dialogDocument,
              "p",
              "lp-muted",
              "The note is stored and exported exactly as written, for this path. Pick the nodes it belongs under; leave all unchecked to keep it unlinked.",
            ),
          );

          const titleLabel = element(dialogDocument, "label", "lp-field");
          titleLabel.append(element(dialogDocument, "span", "lp-field-label", "Title"));
          const titleInput = element(dialogDocument, "input", "lp-input");
          titleInput.setAttribute("aria-label", "Note title");
          titleLabel.append(titleInput);

          const bodyLabel = element(dialogDocument, "label", "lp-field");
          bodyLabel.append(element(dialogDocument, "span", "lp-field-label", "Note (Markdown)"));
          const bodyInput = element(dialogDocument, "textarea", "lp-textarea lp-workspace-note-body");
          bodyInput.setAttribute("aria-label", "Note content");
          bodyInput.rows = 10;
          bodyLabel.append(bodyInput);

          const pickerLabel = element(dialogDocument, "span", "lp-field-label", "Linked nodes");
          const picker = buildPicker(dialogDocument, path, new Set(node ? [node.id] : []));
          root.append(titleLabel, bodyLabel, pickerLabel, picker.root);

          const error = element(dialogDocument, "p", "lp-dialog-error");
          error.setAttribute("role", "alert");
          error.hidden = true;

          const saveHost = element(dialogDocument, "span", "lp-button-host");
          root.append(error, saveHost);
          content.append(root);

          const save = ctx.ui.mountButton(
            saveHost,
            {
              label: "Save Note",
              variant: "default",
              size: "sm",
              onClick: async () => {
                if (contentSignal.aborted) return;
                const title = titleInput.value.trim();
                const markdown = bodyInput.value;
                if (title.length === 0) {
                  error.textContent = "Give the note a title.";
                  error.hidden = false;
                  return;
                }
                if (markdown.trim().length === 0) {
                  error.textContent = "Write something first; an empty note cannot be saved.";
                  error.hidden = false;
                  return;
                }
                error.hidden = true;
                save.update({ disabled: true, label: "Saving…" });
                try {
                  await options.saveNote({
                    title,
                    markdown,
                    links: picker.checked().map((nodeId) => ({ to: nodeId, rel: LEARNER_LINK_REL })),
                  });
                  if (contentSignal.aborted) return;
                  close();
                } catch (problem) {
                  if (contentSignal.aborted) return;
                  error.textContent = `Could not save the note: ${describeError(problem)}`;
                  error.hidden = false;
                  save.update({ disabled: false, label: "Save Note" });
                }
              },
            },
            { signal: contentSignal },
          );
          dialogHandles.push(save);
          return () => {
            save.dispose();
            dialogHandles = dialogHandles.filter((handle) => handle !== save);
            root.remove();
          };
        },
      },
      { signal },
    ) as PluginWidgetHandle<never>;
    dialogHandles.push(dialog);
  }

  /** Links dialog: one item's links across every node of the path. New links
   * are filed rel `informs`; relations already on the item keep their rel. */
  function openLinksDialog(path: LearningPath, item: WorkspaceItem): void {
    if (signal.aborted || disposed) return;
    let dialog: PluginWidgetHandle<never> | null = null;
    const close = (): void => {
      const current = dialog;
      dialog = null;
      current?.dispose();
    };
    const currentRels = new Map(item.links.map((link) => [link.to, link.rel]));
    dialog = ctx.ui.openDialog(
      {
        title: `Links — ${item.title}`,
        content: (content: HTMLElement, contentSignal: AbortSignal): (() => void) | undefined => {
          const dialogDocument = content.ownerDocument;
          const root = element(dialogDocument, "div", "lp-workspace-links-dialog");
          root.append(
            element(
              dialogDocument,
              "p",
              "lp-muted",
              "File this item under every node it belongs to. New links are filed as informs; relations the item already carries keep their relation.",
            ),
          );
          const picker = buildPicker(
            dialogDocument,
            path,
            new Set(item.links.map((link) => link.to)),
          );
          root.append(picker.root);

          const error = element(dialogDocument, "p", "lp-dialog-error");
          error.setAttribute("role", "alert");
          error.hidden = true;

          const saveHost = element(dialogDocument, "span", "lp-button-host");
          root.append(error, saveHost);
          content.append(root);

          const save = ctx.ui.mountButton(
            saveHost,
            {
              label: "Save Links",
              variant: "default",
              size: "sm",
              onClick: async () => {
                if (contentSignal.aborted) return;
                error.hidden = true;
                save.update({ disabled: true, label: "Saving…" });
                try {
                  await options.setItemLinks(
                    item.id,
                    picker.checked().map((nodeId) => ({
                      to: nodeId,
                      rel: currentRels.get(nodeId) ?? LEARNER_LINK_REL,
                    })),
                  );
                  if (contentSignal.aborted) return;
                  close();
                } catch (problem) {
                  if (contentSignal.aborted) return;
                  error.textContent = `Could not save the links: ${describeError(problem)}`;
                  error.hidden = false;
                  save.update({ disabled: false, label: "Save Links" });
                }
              },
            },
            { signal: contentSignal },
          );
          dialogHandles.push(save);
          return () => {
            save.dispose();
            dialogHandles = dialogHandles.filter((handle) => handle !== save);
            root.remove();
          };
        },
      },
      { signal },
    ) as PluginWidgetHandle<never>;
    dialogHandles.push(dialog);
  }

  /** Filing dialog for one dropped (or otherwise delivered) document: the file
   * is converted through `ctx.documents.toMarkdown` (the same pipeline the
   * Architect pane uses), the conversion notices surface here, and the picker
   * supplies the links (rel `grounds`). Saving goes through the caller's
   * `saveSource`, so the global source library stays the single store. The
   * picker may stay empty: the item then starts unlinked, like a note.
   * Resolves when the dialog closes (saved, cancelled or disposed). */
  function openAddSourceDialog(file: File): Promise<void> {
    if (signal.aborted || disposed) return Promise.resolve();
    let dialog: PluginWidgetHandle<never> | null = null;
    const close = (): void => {
      const current = dialog;
      dialog = null;
      current?.dispose();
    };
    return new Promise<void>((resolve) => {
      dialog = ctx.ui.openDialog(
      {
        title: `File “${file.name}” in Workspace`,
        content: (content: HTMLElement, contentSignal: AbortSignal): (() => void) | undefined => {
          const dialogDocument = content.ownerDocument;
          const root = element(dialogDocument, "div", "lp-workspace-source-dialog");
          root.append(
            element(
              dialogDocument,
              "p",
              "lp-muted",
              "The document is converted to Markdown and stored once in your source library; the workspace entry references it. Pick the nodes it grounds; leave all unchecked to keep it unlinked.",
            ),
          );
          const status = element(dialogDocument, "p", "lp-muted lp-workspace-source-status");
          status.setAttribute("role", "status");
          status.textContent = `Converting ${file.name}…`;
          const pickerLabel = element(dialogDocument, "span", "lp-field-label", "Linked nodes");
          const picker = buildPicker(
            dialogDocument,
            pathWithoutNull(),
            new Set(lastNode ? [lastNode.id] : []),
          );
          root.append(status, pickerLabel, picker.root);

          const error = element(dialogDocument, "p", "lp-dialog-error");
          error.setAttribute("role", "alert");
          error.hidden = true;

          const saveHost = element(dialogDocument, "span", "lp-button-host");
          root.append(error, saveHost);
          content.append(root);

          const save = ctx.ui.mountButton(
            saveHost,
            {
              label: "Save to Workspace",
              variant: "default",
              size: "sm",
              disabled: true,
              onClick: async () => {
                if (contentSignal.aborted || converted === null) return;
                error.hidden = true;
                save.update({ disabled: true, label: "Saving…" });
                try {
                  await options.saveSource({
                    name: converted.name,
                    markdown: converted.markdown,
                    links: picker.checked().map((nodeId) => ({ to: nodeId, rel: DOCUMENT_LINK_REL })),
                  });
                  if (contentSignal.aborted) return;
                  close();
                } catch (problem) {
                  if (contentSignal.aborted) return;
                  error.textContent = `Could not file the document: ${describeError(problem)}`;
                  error.hidden = false;
                  save.update({ disabled: false, label: "Save to Workspace" });
                }
              },
            },
            { signal: contentSignal },
          );
          dialogHandles.push(save);

          let converted: { name: string; markdown: string } | null = null;
          void (async () => {
            try {
              const result = await ctx.documents.toMarkdown(file, { signal: contentSignal });
              if (contentSignal.aborted) return;
              converted = { name: result.name, markdown: result.markdown };
              status.textContent = result.notices.length > 0 ? result.notices.join(" ") : "";
              save.update({ disabled: false, label: "Save to Workspace" });
            } catch (problem) {
              if (contentSignal.aborted) return;
              status.textContent = "";
              error.textContent = `Could not convert ${file.name}: ${describeError(problem)}`;
              error.hidden = false;
            }
          })();

          return () => {
            save.dispose();
            dialogHandles = dialogHandles.filter((handle) => handle !== save);
            root.remove();
            resolve();
          };
        },
      },
      { signal },
      ) as PluginWidgetHandle<never>;
      dialogHandles.push(dialog);
    });
  }

  /** The dialog only opens from a rendered ledger, which always has a path
   * (onDrop refuses to queue while none is rendered). */
  function pathWithoutNull(): LearningPath {
    return lastPath as LearningPath;
  }

  /** Dropped documents queue one at a time: each conversion opens its filing
   * dialog, and the next file waits until the learner resolves the current one. */
  let dropQueue: File[] = [];
  let filingDrop = false;

  async function processDropQueue(): Promise<void> {
    if (filingDrop || signal.aborted || disposed) return;
    filingDrop = true;
    try {
      while (dropQueue.length > 0 && !signal.aborted && !disposed) {
        const file = dropQueue.shift()!;
        await openAddSourceDialog(file);
      }
    } finally {
      filingDrop = false;
    }
  }

  /** Take convertible files from a drop or the native picker and queue them. */
  const queueFiles = (files: readonly File[]): void => {
    const convertible = files.filter(isConvertibleFile);
    if (convertible.length === 0 || lastPath === null) return;
    dropQueue.push(...convertible);
    void processDropQueue();
  };

  /** The one visible drop affordance, scoped so it never clashes with the path
   * surfaces behind the floating pane: only this strip arms on dragover and
   * accepts a drop; a file dragged over the roadmap or the pane's list is not
   * intercepted. The same strip carries the native "select from computer"
   * picker, so dragging and picking are one filing affordance. */
  function dropzone(): HTMLElement {
    const zone = element(document, "div", "lp-workspace-dropzone");
    const icon = element(document, "span", "lp-workspace-dropzone-icon");
    icon.append(
      svgIcon(document, ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M17 8l-5-5-5 5", "M12 3v12"]),
    );
    zone.append(
      icon,
      element(
        document,
        "span",
        "lp-workspace-dropzone-text",
        "Drag a PDF or text file here to file it in this workspace.",
      ),
    );

    const pickerHost = element(document, "span", "lp-button-host");
    zone.append(pickerHost);
    const fileInput = element(document, "input", "lp-file-input");
    fileInput.type = "file";
    fileInput.accept = UPLOAD_ACCEPT_TYPES;
    fileInput.hidden = true;
    fileInput.setAttribute("aria-label", "Select a PDF or text file from your computer");
    zone.append(fileInput);
    nativeButton(
      pickerHost,
      "Select from computer…",
      () => {
        if (!signal.aborted && !disposed) fileInput.click();
      },
      { variant: "outline", size: "sm", title: "Pick a PDF or text file to convert and file in this workspace" },
    );
    fileInput.addEventListener(
      "change",
      () => {
        if (signal.aborted || disposed) return;
        queueFiles([...(fileInput.files ?? [])]);
        fileInput.value = "";
      },
      { signal },
    );

    zone.addEventListener(
      "dragover",
      ((event: DragEvent) => {
        if (signal.aborted || disposed) return;
        event.preventDefault();
        event.stopPropagation();
        zone.classList.add("lp-drop-target");
      }) as EventListener,
      { signal },
    );
    zone.addEventListener(
      "dragleave",
      () => {
        zone.classList.remove("lp-drop-target");
      },
      { signal },
    );
    zone.addEventListener(
      "drop",
      ((event: DragEvent) => {
        if (signal.aborted || disposed) return;
        event.preventDefault();
        event.stopPropagation();
        zone.classList.remove("lp-drop-target");
        queueFiles([...(event.dataTransfer?.files ?? [])]);
      }) as EventListener,
      { signal },
    );
    return zone;
  }

  /** A source item references the global sources store; it has no content file
   * of its own, so its preview says where its text lives — nothing is fetched. */
  const SOURCE_PREVIEW_NOTE =
    "This source lives in the path's source library; its text is read there, not stored in the workspace.";

  /** A content-bearing item whose file is missing: honest, never an error. */
  const NO_CONTENT_NOTE =
    "This item carries no content file of its own; there is nothing to read here.";

  /** Rebuild the ledger rows from the caller's last-seen state and push them
   * into the mounted tree in place — no remount, so expanded previews and
   * their content mounts survive a disclosure toggle and a landed read. */
  function updateLedgerRows(): void {
    if (!ledgerTree || disposed || signal.aborted || !lastPath) return;
    const items = [...(lastWorkspace?.items ?? [])].sort((a, b) => a.addedAt.localeCompare(b.addedAt));
    ledgerTree.update({ rows: items.map((item) => treeRow(item, lastPath!, lastNode)) });
  }

  /** Expanding a row is the only moment content is read: the fetch is lazy
   * (`workspace.readItem`), the tree paints the loading preview at once, and
   * the rows update in place when the read lands. Collapsing never re-reads. */
  function expandPreview(item: WorkspaceItem): void {
    expandedItemIds.add(item.id);
    if (item.kind !== "source" && !previewCache.has(item.id) && !previewErrors.has(item.id)) {
      void (async () => {
        try {
          const content = await options.readItem(item.id);
          if (signal.aborted || disposed) return;
          previewCache.set(item.id, content);
          previewErrors.delete(item.id);
        } catch (problem) {
          if (signal.aborted || disposed) return;
          previewErrors.set(item.id, describeError(problem));
        }
        updateLedgerRows();
      })();
    }
    updateLedgerRows();
  }

  /** The expanded preview row: rendered inside the tree, under its item. */
  function previewRow(item: WorkspaceItem): PluginTreeRow {
    return {
      key: `${item.id}-preview`,
      content: previewContent(item),
    };
  }

  function previewContent(item: WorkspaceItem): PluginTreeContent {
    if (item.kind === "source") return SOURCE_PREVIEW_NOTE;
    const error = previewErrors.get(item.id);
    if (error !== undefined) return `Could not read the item: ${error}`;
    if (!previewCache.has(item.id)) return "Loading…";
    const text = previewCache.get(item.id);
    if (text === null || text === undefined) return NO_CONTENT_NOTE;
    return (container: HTMLElement, contentSignal: AbortSignal): (() => void) => {
      const host = element(document, "div", "lp-workspace-preview");
      container.append(host);
      // Read-only rendering, scoped to the tree's content mount: the host
      // disposes it when the row collapses, is replaced or unmounts.
      ctx.ui.mountMarkdown(host, { text }, { signal: contentSignal });
      return () => {
        host.remove();
      };
    };
  }

  /** One ledger row: the title reads in the tree's lead column, kind, filing
   * and actions read as columns, and the disclosure expands the item's body in
   * place — the note never leaves the list, so there is no separate viewer. */
  function treeRow(item: WorkspaceItem, path: LearningPath, node: PathNode | null): PluginTreeRow {
    const expanded = expandedItemIds.has(item.id);
    return {
      key: item.id,
      content: item.title,
      cells: {
        kind: kindIcon(document, item.kind),
        filed: filedUnderText(item, path, node),
        actions: rowActions(item, path),
      },
      disclosure: {
        label: `Preview ${item.title}`,
        expanded,
        onChange: (next: boolean) => {
          if (signal.aborted || disposed) return;
          if (next) {
            expandPreview(item);
            return;
          }
          expandedItemIds.delete(item.id);
          updateLedgerRows();
        },
      },
      ...(expanded ? { children: [previewRow(item)] } : {}),
    };
  }

  /** Honest inventory of where the item is filed; no unread or new state.
   * Session artifacts carry their provenance: which session saved them. */
  function filedUnderText(item: WorkspaceItem, path: LearningPath, node: PathNode | null): string {
    const nodeTitles = item.links.flatMap((link) => {
      const target = path.modules.flatMap((module) => module.nodes).find((candidate) => candidate.id === link.to);
      return target ? [`${target.title} (${link.rel})`] : [];
    });
    const parts: string[] = [];
    if (nodeTitles.length > 0) parts.push(`linked: ${nodeTitles.join(", ")}`);
    else parts.push("unlinked");
    if (node && item.links.some((link) => link.to === node.id)) parts.push("linked here");
    if (item.kind === "session_artifact" && item.addedBy.startsWith("session:")) {
      parts.push(`saved by ${item.addedBy.replace(":", " ")}`);
    }
    return parts.join(" · ");
  }

  function rowActions(item: WorkspaceItem, path: LearningPath): HTMLElement {
    const actions = element(document, "span", "lp-workspace-row-actions");
    // Row actions are icon-only (the label stays the accessible name, the
    // hover title carries the word), so the Actions column stays compact:
    // an outbound arrow for the editor, a chain link for filing, a trashcan
    // for removal.
    if (item.kind !== "source") {
      nativeButton(
        actions,
        "Open in editor…",
        () => {
          void options.openItem(item.id);
        },
        {
          variant: "ghost",
          size: "sm",
          title: `Open ${item.title} in an editor on your computer`,
          icon: OPEN_EDITOR_ICON_PATHS,
        },
      );
    }
    nativeButton(actions, "Links…", () => openLinksDialog(path, item), {
      size: "sm",
      title: "Link to a node",
      icon: LINK_ICON_PATHS,
    });
    nativeButton(actions, "Delete", () => {
      void options.deleteItem(item.id);
    }, { variant: "ghost", size: "sm", title: `Delete ${item.title}`, icon: TRASH_ICON_PATHS });
    return actions;
  }

  let lastPath: LearningPath | null = null;
  let lastNode: PathNode | null = null;
  let lastWorkspace: WorkspaceManifest | null = null;

  function renderState(
    path: LearningPath | null,
    node: PathNode | null,
    workspace: WorkspaceManifest | null,
  ): void {
    if (disposed || signal.aborted) return;
    clear();
    lastPath = path;
    lastNode = node;
    lastWorkspace = workspace;
    if (!path) return;

    const items = [...(workspace?.items ?? [])].sort((a, b) =>
      a.addedAt.localeCompare(b.addedAt),
    );

    const header = element(document, "div", "lp-workspace-header");
    // Honest inventory only: no unread counts, no "new" badges anywhere.
    header.append(
      element(document, "span", "lp-muted", `${items.length} item${items.length === 1 ? "" : "s"}`),
    );
    const headerActions = element(document, "span", "lp-workspace-row-actions");
    header.append(headerActions);
    container.append(header);
    nativeButton(
      headerActions,
      "Open folder",
      () => {
        void options.openDirectory();
      },
      {
        variant: "outline",
        size: "sm",
        title: "Open this workspace's folder in your computer's file manager",
        icon: FOLDER_OPEN_ICON_PATHS,
      },
    );
    nativeButton(
      headerActions,
      "Add Note",
      () => {
        if (!signal.aborted && !disposed) openAddNoteDialog(path, node);
      },
      { variant: "outline", size: "sm", title: "Add a note to this workspace", icon: PLUS_ICON_PATHS },
    );

    // The one filing affordance for documents: drag-and-drop and the native
    // picker share this strip, and only it accepts a drop — never the ledger
    // tree or the path surfaces beside the pane.
    container.append(dropzone());

    if (items.length === 0) {
      container.append(
        element(
          document,
          "p",
          "lp-muted",
          "No workspace items yet. Add a note to keep your own material with this path.",
        ),
      );
      return;
    }

    // The ledger list is the host tree: the host owns rows, columns, keyboard
    // navigation and virtualization; newest last reads like a flat history of
    // what was added, and expanded rows preview their bodies in place.
    const list = element(document, "div", "lp-workspace-list");
    container.append(list);
    const tree = ctx.ui.mountTree(
      list,
      {
        label: "Workspace ledger",
        header: "Title",
        rows: items.map((item) => treeRow(item, path, node)),
        columns: [
          { key: "kind", header: "Kind", width: 72 },
          { key: "filed", header: "Filed under", width: "16rem" },
          { key: "actions", header: "Actions", width: "7rem" },
        ],
      },
      { signal },
    );
    handles.push(tree);
    ledgerTree = tree;
  }

  return {
    render(path, node, workspace) {
      if (disposed || signal.aborted) return;
      renderState(path, node, workspace);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clear();
      for (const handle of dialogHandles.reverse()) handle.dispose();
      dialogHandles = [];
      container.replaceChildren();
    },
  };
}

/** Exported for tests and the Architect pane's upload dialog: every node of
 * the path, module order, as picker options. The picker is the one filing
 * surface: checkboxes, not drag order, never progression. */
export function nodeOptions(path: LearningPath): readonly { nodeId: string; title: string; moduleTitle: string }[] {
  return path.modules.flatMap((module) =>
    module.nodes.map((node) => ({ nodeId: node.id, title: node.title, moduleTitle: module.title })),
  );
}

export function buildNodePicker(
  dialogDocument: Document,
  path: LearningPath,
  checkedNodeIds: ReadonlySet<string>,
): { root: HTMLElement; checked(): string[] } {
  const root = element(dialogDocument, "div", "lp-workspace-picker");
  root.setAttribute("aria-label", "Node picker");
  const inputs = new Map<string, HTMLInputElement>();
  for (const option of nodeOptions(path)) {
    const label = element(dialogDocument, "label", "lp-workspace-picker-option");
    const input = element(dialogDocument, "input", "lp-checkbox");
    input.type = "checkbox";
    input.value = option.nodeId;
    input.checked = checkedNodeIds.has(option.nodeId);
    input.setAttribute(
      "aria-label",
      `Link to ${option.title} (${option.moduleTitle})`,
    );
    inputs.set(option.nodeId, input);
    label.append(input);
    label.append(element(dialogDocument, "span", undefined, option.title));
    root.append(label);
  }
  return {
    root,
    checked: () => [...inputs.entries()].filter(([, input]) => input.checked).map(([nodeId]) => nodeId),
  };
}

/** Exported for tests: the kinds a ledger row can show. */
export const WORKSPACE_KINDS = WORKSPACE_ITEM_KINDS;
