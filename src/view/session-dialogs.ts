/** Learning Path — attach/link dialogs for child sessions.
 *
 * Both dialogs are explicit learner actions: they list plugin paths/nodes and
 * native chats read through the backend, and only write a link after a click.
 * They never create sessions (that is the launcher) and never delete chats.
 * Content and every widget belong to the supplied signal, so leaving the view
 * or closing the dialog disposes them.
 */
import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import type { ChildSessionKind, LearningPath, PathNode } from "../domain.ts";
import type { SessionLauncher } from "../session-launcher.ts";
import type {
  AvailableSession,
  SessionLinkResult,
  SessionParentResult,
} from "../session-types.ts";

interface PathSummaryLike {
  readonly id: string;
  readonly title: string;
}

interface PathsListResult {
  readonly paths: readonly PathSummaryLike[];
}

interface PathResult {
  readonly path: LearningPath | null;
}

export interface AttachDialogOptions {
  readonly launcher: SessionLauncher;
  readonly chatId: string;
  readonly kind: ChildSessionKind;
  readonly signal: AbortSignal;
  readonly onLinked?: (result: SessionLinkResult) => void;
}

export interface LinkExistingDialogOptions {
  readonly launcher: SessionLauncher;
  readonly pathId: string;
  readonly nodeId: string;
  readonly nodeTitle: string;
  readonly signal: AbortSignal;
  readonly onLinked?: (result: SessionLinkResult) => void;
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
    select.options[0]?.value ||
    ""
  );
}

function allNodes(path: LearningPath): PathNode[] {
  return path.modules.flatMap((module) => module.nodes);
}

function kindLabel(kind: ChildSessionKind): string {
  return kind === "teaching" ? "Teaching" : "Practice";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Attach the session the action was invoked from to a learner-chosen node. */
export function openAttachSessionDialog(
  ctx: PluginFrontendContext,
  options: AttachDialogOptions,
): PluginWidgetHandle<{ title: string; content: unknown }> | null {
  let dialog: PluginWidgetHandle<never> | null = null;

  const close = (): void => {
    const current = dialog;
    dialog = null;
    current?.dispose();
  };

  dialog = ctx.ui.openDialog(
    {
      title: "Attach Session to Path",
      content: async (container: HTMLElement, contentSignal: AbortSignal) => {
        const document = container.ownerDocument;
        const handles: PluginWidgetHandle<unknown>[] = [];
        const root = element(document, "div", "lp-session-dialog");
        const loading = element(document, "p", "lp-muted", "Loading paths…");
        root.append(loading);
        container.append(root);

        const status = element(document, "p", "lp-dialog-status");
        status.setAttribute("role", "status");
        const error = element(document, "p", "lp-dialog-error");
        error.setAttribute("role", "alert");
        error.hidden = true;

        const cleanup = (): void => {
          for (const handle of handles.reverse()) handle.dispose();
          handles.length = 0;
          root.remove();
        };

        try {
          const [listed, parent] = await Promise.all([
            ctx.call<PathsListResult>("paths.list"),
            ctx.call<SessionParentResult>("sessions.forChat", { chatId: options.chatId }),
          ]);
          if (contentSignal.aborted || options.signal.aborted) return cleanup;
          loading.remove();

          if (parent.link) {
            root.append(
              element(
                document,
                "p",
                "lp-muted",
                `This session is already linked to "${parent.link.nodeTitle}" in "${parent.link.pathTitle}".`,
              ),
            );
            return cleanup;
          }

          if ((listed.paths ?? []).length === 0) {
            root.append(
              element(
                document,
                "p",
                "lp-muted",
                "No learning paths exist yet. Create a path first, then attach this session.",
              ),
            );
            return cleanup;
          }

          const pathLabel = element(document, "label", "lp-field");
          pathLabel.append(element(document, "span", "lp-field-label", "Learning path"));
          const pathSelect = element(document, "select", "lp-select");
          pathSelect.setAttribute("aria-label", "Learning path");
          for (const summary of listed.paths) {
            const option = element(document, "option", undefined, summary.title);
            option.value = summary.id;
            pathSelect.append(option);
          }
          pathLabel.append(pathSelect);

          const nodeLabel = element(document, "label", "lp-field");
          nodeLabel.append(element(document, "span", "lp-field-label", "Node"));
          const nodeSelect = element(document, "select", "lp-select");
          nodeSelect.setAttribute("aria-label", "Node");
          nodeLabel.append(nodeSelect);

          root.append(pathLabel, nodeLabel, status, error);

          const buttonHost = element(document, "span", "lp-button-host");
          root.append(buttonHost);
          let currentPath: LearningPath | null = null;

          const attachButton = ctx.ui.mountButton(
            buttonHost,
            {
              label: "Attach Session",
              variant: "default",
              size: "sm",
              disabled: true,
              onClick: async () => {
                const nodeId = selectedValue(nodeSelect);
                if (!currentPath || !nodeId || contentSignal.aborted) return;
                error.hidden = true;
                attachButton.update({ disabled: true, label: "Attaching…" });
                try {
                  const result = await options.launcher.attach({
                    pathId: currentPath.id,
                    nodeId,
                    chatId: options.chatId,
                    kind: options.kind,
                  });
                  if (contentSignal.aborted) return;
                  status.textContent = `Attached to "${result.link.label}".`;
                  status.dataset.state = "success";
                  options.onLinked?.(result);
                  close();
                } catch (problem) {
                  if (contentSignal.aborted) return;
                  error.textContent = `Could not attach the session: ${describeError(problem)}`;
                  error.hidden = false;
                  attachButton.update({ disabled: false, label: "Attach Session" });
                }
              },
            },
            { signal: contentSignal },
          );
          handles.push(attachButton);

          const loadPath = async (): Promise<void> => {
            const pathId = selectedValue(pathSelect);
            nodeSelect.replaceChildren();
            attachButton.update({ disabled: true });
            try {
              const result = await ctx.call<PathResult>("paths.get", { id: pathId });
              if (contentSignal.aborted) return;
              currentPath = result.path;
              if (!currentPath) throw new Error("That path no longer exists.");
              for (const node of allNodes(currentPath)) {
                const option = element(
                  document,
                  "option",
                  undefined,
                  `${node.title} (${node.type})`,
                );
                option.value = node.id;
                nodeSelect.append(option);
              }
              attachButton.update({ disabled: nodeSelect.options.length === 0 });
            } catch (problem) {
              if (contentSignal.aborted) return;
              currentPath = null;
              error.textContent = `Could not load the path: ${describeError(problem)}`;
              error.hidden = false;
            }
          };

          pathSelect.addEventListener("change", () => {
            if (!contentSignal.aborted) void loadPath();
          });
          await loadPath();
          return cleanup;
        } catch (problem) {
          if (contentSignal.aborted) return;
          loading.remove();
          error.textContent = `Could not prepare the attach dialog: ${describeError(problem)}`;
          error.hidden = false;
          root.append(error);
          return cleanup;
        }
      },
    },
    { signal: options.signal },
  ) as PluginWidgetHandle<never>;

  return dialog as unknown as PluginWidgetHandle<{ title: string; content: unknown }> | null;
}

/** List native sessions and attach one of them to a known node. */
export function openLinkExistingSessionDialog(
  ctx: PluginFrontendContext,
  options: LinkExistingDialogOptions,
): PluginWidgetHandle<{ title: string; content: unknown }> | null {
  let dialog: PluginWidgetHandle<never> | null = null;

  const close = (): void => {
    const current = dialog;
    dialog = null;
    current?.dispose();
  };

  dialog = ctx.ui.openDialog(
    {
      title: "Link Existing Session",
      content: async (container: HTMLElement, contentSignal: AbortSignal) => {
        const document = container.ownerDocument;
        const handles: PluginWidgetHandle<unknown>[] = [];
        const root = element(document, "div", "lp-session-dialog");
        const loading = element(document, "p", "lp-muted", "Loading sessions…");
        root.append(loading);
        container.append(root);

        const status = element(document, "p", "lp-dialog-status");
        status.setAttribute("role", "status");
        const error = element(document, "p", "lp-dialog-error");
        error.setAttribute("role", "alert");
        error.hidden = true;

        const cleanup = (): void => {
          for (const handle of handles.reverse()) handle.dispose();
          handles.length = 0;
          root.remove();
        };

        try {
          const sessions = await options.launcher.available();
          if (contentSignal.aborted || options.signal.aborted) return cleanup;
          loading.remove();
          root.append(
            element(
              document,
              "p",
              "lp-muted",
              `Choose a native teaching or practice session to link under "${options.nodeTitle}". Only sessions not already linked are offered.`,
            ),
          );

          const free = (sessions as readonly AvailableSession[]).filter(
            (session) => session.linked === null,
          );
          if (free.length === 0) {
            root.append(
              element(
                document,
                "p",
                "lp-muted",
                "No unlinked native sessions are available. Start a Teaching or Practice chat first.",
              ),
            );
            return cleanup;
          }

          const list = element(document, "ul", "lp-session-picker");
          root.append(list, status, error);
          for (const session of free) {
            const item = element(document, "li", "lp-session-picker-row");
            const label = element(
              document,
              "span",
              "lp-session-picker-label",
              `${kindLabel(session.kind)} — ${session.title}`,
            );
            const host = element(document, "span", "lp-button-host");
            item.append(label, host);
            const link = ctx.ui.mountButton(
              host,
              {
                label: "Link",
                variant: "outline",
                size: "xs",
                onClick: async () => {
                  if (contentSignal.aborted) return;
                  error.hidden = true;
                  link.update({ disabled: true, label: "Linking…" });
                  try {
                    const result = await options.launcher.attach({
                      pathId: options.pathId,
                      nodeId: options.nodeId,
                      chatId: session.chatId,
                      kind: session.kind,
                      label: session.title,
                    });
                    if (contentSignal.aborted) return;
                    status.textContent = `Linked "${session.title}".`;
                    status.dataset.state = "success";
                    options.onLinked?.(result);
                    close();
                  } catch (problem) {
                    if (contentSignal.aborted) return;
                    error.textContent = `Could not link the session: ${describeError(problem)}`;
                    error.hidden = false;
                    link.update({ disabled: false, label: "Link" });
                  }
                },
              },
              { signal: contentSignal },
            );
            handles.push(link);
            list.append(item);
          }
          return cleanup;
        } catch (problem) {
          if (contentSignal.aborted) return;
          loading.remove();
          error.textContent = `Could not list native sessions: ${describeError(problem)}`;
          error.hidden = false;
          root.append(error);
          return cleanup;
        }
      },
    },
    { signal: options.signal },
  ) as PluginWidgetHandle<never>;

  return dialog as unknown as PluginWidgetHandle<{ title: string; content: unknown }> | null;
}
