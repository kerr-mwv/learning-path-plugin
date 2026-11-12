/** Dedicated Learning Paths Settings page.
 *
 * Three sections on one lazily mounted page:
 * - artifact defaults per node type, each showing the framework's justification
 *   for every option and the recommendation for that node type;
 * - the Architect model preference: follow the host strong slot, or override
 *   with the host model/thinking pickers;
 * - path management. Deletion removes only this plugin's path record and any
 *   converted source files no surviving path uses. Native LearnHarness chats and
 *   Knowledge Graph records are host-owned and are never touched.
 *
 * The host does not persist plugin settings for us. Every accepted change is
 * written through `settings.save`, and the saved record is fed back into the
 * controlled widgets; failures are shown inline.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type {
  PluginDialogProps,
  PluginFrontendContext,
  PluginModelValue,
  PluginSettingsRow,
  PluginSettingsSchema,
  PluginWidgetHandle,
} from "learnharness-plugin-api";
import {
  ARTIFACT_CATALOG,
  NODE_TYPES,
  artifactCatalogEntry,
  defaultArtifactFor,
  recommendedArtifactsFor,
} from "./domain.ts";
import type {
  ArchitectPreferences,
  ArtifactType,
  NodeType,
  PluginSettings,
  ThinkingLevelName,
} from "./domain.ts";
import { EVENT_PATHS_CHANGED, EVENT_SETTINGS_CHANGED } from "./topics.ts";
import { NODE_TYPE_LABELS, artifactLabel } from "./view/labels.ts";

interface PathSummary {
  readonly id: string;
  readonly title: string;
  readonly moduleCount: number;
  readonly nodeCount: number;
}

interface SettingsResult {
  readonly settings: PluginSettings;
  /** The new Architect model waits for a running Architect conversation to finish. */
  readonly modelPending?: boolean;
}

interface PathsResult {
  readonly paths: readonly PathSummary[];
}

interface DeleteResult {
  readonly deleted: boolean;
  readonly removedSources: readonly string[];
  readonly retainedSources: readonly string[];
  readonly preservedChats: number;
  readonly knowledgeGraphRecordsChanged: number;
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

function errorMessage(problem: unknown): string {
  if (problem instanceof Error && problem.message.trim()) return problem.message;
  return typeof problem === "string" && problem.trim() ? problem : "Unexpected error.";
}

/** A section wrapper with a heading and an optional intro paragraph. */
function section(document: Document, container: HTMLElement, title: string, intro?: string): HTMLElement {
  const wrapper = element(document, "section", "lp-settings-section");
  wrapper.append(element(document, "h2", "lp-settings-heading", title));
  if (intro !== undefined) wrapper.append(element(document, "p", "lp-muted", intro));
  container.append(wrapper);
  return wrapper;
}

export function mountSettingsPage(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
): () => void {
  const document = container.ownerDocument;
  const root = element(document, "div", "lp-settings");
  container.append(root);

  root.append(element(document, "h1", "lp-settings-title", "Learning Paths"));
  root.append(
    element(
      document,
      "p",
      "lp-muted",
      "Defaults for generated artifacts, the Architect's model, and safe path deletion. Every change saves immediately.",
    ),
  );
  const status = element(document, "p", "lp-settings-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  root.append(status);

  const artifactsSection = section(
    document,
    root,
    "Artifact defaults",
    "Per node type. A node override and then a path default still win; the framework's recommendation is the fallback.",
  );
  const artifactRowsHost = element(document, "div", "lp-settings-rows");
  artifactsSection.append(artifactRowsHost);

  const catalogDetails = element(document, "details", "lp-artifact-catalog");
  catalogDetails.open = true;
  catalogDetails.append(
    element(document, "summary", undefined, "Why the framework recommends each artifact"),
  );
  for (const entry of ARTIFACT_CATALOG) {
    const card = element(document, "article", "lp-artifact-option");
    card.dataset.artifactType = entry.type;
    card.append(element(document, "h3", "lp-artifact-option-title", entry.label));
    card.append(element(document, "p", "lp-artifact-justification", entry.justification));
    card.append(
      element(
        document,
        "p",
        "lp-muted",
        `Best suited for: ${entry.bestFor.map((type) => NODE_TYPE_LABELS[type]).join(", ")}.`,
      ),
    );
    catalogDetails.append(card);
  }
  artifactsSection.append(catalogDetails);

  const architectSection = section(
    document,
    root,
    "Path Architect model",
    "Follow the host's strong slot, or override the model and thinking level for Architect conversations only.",
  );
  const architectHost = element(document, "div", "lp-architect-settings");
  architectSection.append(architectHost);

  const pathsSection = section(
    document,
    root,
    "Path management",
    "Deleting a path removes only this plugin's records and orphaned converted source files. Native LearnHarness chats and Knowledge Graph records are never deleted.",
  );
  const pathsHost = element(document, "div", "lp-settings-paths");
  pathsSection.append(pathsHost);

  let settings: PluginSettings = { artifactDefaults: {} };
  /** Unsaved "override is on but no model chosen yet" draft; never persisted. */
  let overrideDraft: ArchitectPreferences | null = null;
  let summaries: readonly PathSummary[] = [];
  let artifactRows: PluginWidgetHandle<PluginSettingsSchema> | null = null;
  let architectHandles: PluginWidgetHandle<unknown>[] = [];
  let pathHandles: PluginWidgetHandle<unknown>[] = [];
  const dialogs: PluginWidgetHandle<PluginDialogProps>[] = [];
  let loadToken = 0;
  let disposed = false;

  const live = (token: number): boolean => !disposed && !signal.aborted && token === loadToken;

  function setStatus(message: string | null, kind: "info" | "error" = "info"): void {
    if (disposed || signal.aborted) return;
    status.textContent = message ?? "";
    status.hidden = message === null;
    delete status.dataset.state;
    if (message !== null) status.dataset.state = kind;
  }

  function clearArchitect(): void {
    for (const handle of architectHandles.reverse()) handle.dispose();
    architectHandles = [];
    architectHost.replaceChildren();
  }

  function clearPaths(): void {
    for (const handle of pathHandles.reverse()) handle.dispose();
    pathHandles = [];
    pathsHost.replaceChildren();
  }

  const chooseArtifact = async (type: NodeType, value: string): Promise<void> => {
    const artifactDefaults = { ...settings.artifactDefaults };
    if (value === "") delete artifactDefaults[type];
    else artifactDefaults[type] = value as ArtifactType;
    await saveSettings({ ...settings, artifactDefaults });
  };

  function artifactRowsFor(state: PluginSettings): PluginSettingsRow[] {
    return NODE_TYPES.map((type) => {
      const chosen = state.artifactDefaults[type];
      const fallback = defaultArtifactFor(type);
      const current = artifactCatalogEntry(chosen ?? fallback);
      const recommended = recommendedArtifactsFor(type)
        .map((artifact) => artifactLabel(artifact))
        .join(", ");
      return {
        key: `artifact-${type}`,
        type: "dropdown" as const,
        label: NODE_TYPE_LABELS[type],
        description: `Recommended: ${recommended}. Current choice — why: ${current.justification}`,
        value: chosen ?? "",
        options: [
          {
            value: "",
            label: `Framework default — ${artifactLabel(fallback)}`,
          },
          ...ARTIFACT_CATALOG.map((entry) => ({ value: entry.type, label: entry.label })),
        ],
        onChange: (value: string) => chooseArtifact(type, value),
      };
    });
  }

  function renderArtifactRows(): void {
    if (disposed || signal.aborted) return;
    const rows = artifactRowsFor(settings);
    if (artifactRows) artifactRows.update({ rows });
    else artifactRows = ctx.ui.mountSettingsRows(artifactRowsHost, { rows }, { signal });
  }

  function preferences(): ArchitectPreferences {
    return overrideDraft ?? settings.architect ?? { followHostSlot: true };
  }

  async function setFollowHost(value: boolean): Promise<void> {
    const current = preferences();
    if (value) {
      overrideDraft = null;
      await saveSettings({ ...settings, architect: { followHostSlot: true } });
      return;
    }
    // Turning the override on exposes the pickers. The draft is deliberately not
    // saved: an invalid half-configured record must never reach the store.
    overrideDraft = {
      followHostSlot: false,
      ...(current.model === undefined ? {} : { model: current.model }),
      ...(current.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: current.thinkingLevel }),
    };
    renderArchitect();
    setStatus(
      current.model === undefined
        ? "Choose a model to finish the override."
        : "Override ready. Choose a model or keep the current one.",
    );
  }

  async function setArchitectModel(value: PluginModelValue): Promise<void> {
    overrideDraft = null;
    await saveSettings({
      ...settings,
      architect: {
        followHostSlot: false,
        model: { provider: value.provider, id: value.id },
      },
    });
  }

  async function setThinking(value: ThinkingLevel): Promise<void> {
    const current = preferences();
    if (current.model === undefined) return;
    overrideDraft = null;
    await saveSettings({
      ...settings,
      architect: {
        followHostSlot: false,
        model: current.model,
        thinkingLevel: value as ThinkingLevelName,
      },
    });
  }

  function renderArchitect(): void {
    if (disposed || signal.aborted) return;
    clearArchitect();
    const current = preferences();

    const rowsHost = element(document, "div", "lp-settings-rows");
    architectHost.append(rowsHost);
    architectHandles.push(
      ctx.ui.mountSettingsRows(
        rowsHost,
        {
          rows: [
            {
              key: "architect-follow-host",
              type: "toggle" as const,
              label: "Follow the host's strong model",
              description:
                "On: the Architect uses the host strong slot and its thinking preference. Off: choose an explicit plugin override below.",
              value: current.followHostSlot,
              onChange: (value: boolean) => setFollowHost(value),
            },
          ],
        },
        { signal },
      ),
    );

    if (current.followHostSlot) {
      architectHost.append(
        element(
          document,
          "p",
          "lp-muted",
          "Following the host strong slot. Change it in Settings → Agent → Models if you need another default.",
        ),
      );
      return;
    }

    const modelHost = element(document, "div", "lp-model-picker-host");
    architectHost.append(
      element(document, "h3", "lp-settings-subheading", "Architect model override"),
      modelHost,
    );
    const modelValue =
      current.model === undefined
        ? undefined
        : { provider: current.model.provider, id: current.model.id };
    architectHandles.push(
      ctx.ui.mountModelPicker(
        modelHost,
        {
          value: modelValue,
          onChange: (value: PluginModelValue) => setArchitectModel(value),
        },
        { signal },
      ),
    );

    const thinkingHost = element(document, "div", "lp-thinking-picker-host");
    architectHost.append(
      element(document, "h3", "lp-settings-subheading", "Thinking level"),
      thinkingHost,
    );
    architectHandles.push(
      ctx.ui.mountThinkingPicker(
        thinkingHost,
        {
          model: modelValue,
          value: current.thinkingLevel,
          disabled: modelValue === undefined,
          onChange: (value: ThinkingLevel) => setThinking(value),
        },
        { signal },
      ),
    );
  }

  async function deletePath(summary: PathSummary): Promise<void> {
    try {
      const result = await ctx.call<DeleteResult>("paths.delete", { pathId: summary.id });
      if (disposed || signal.aborted) return;
      let message: string;
      if (!result.deleted) {
        message = `"${summary.title}" was already gone; nothing was removed.`;
      } else {
        const sources =
          result.removedSources.length === 0
            ? "No converted source files became orphaned."
            : `Removed ${result.removedSources.length} orphaned converted source file(s).` +
              (result.retainedSources.length === 0
                ? ""
                : ` ${result.retainedSources.length} source file(s) are still used by another path.`);
        message =
          `Deleted "${summary.title}". ${sources} ${result.preservedChats} native chat link(s) released; ` +
          "native chats and Knowledge Graph records were not touched.";
      }
      await load();
      setStatus(message, "info");
    } catch (problem) {
      if (disposed || signal.aborted) return;
      setStatus(`Could not delete "${summary.title}": ${errorMessage(problem)}`, "error");
    }
  }

  function openDeleteDialog(summary: PathSummary): void {
    if (disposed || signal.aborted) return;
    let dialog: PluginWidgetHandle<PluginDialogProps> | null = null;
    dialog = ctx.ui.openDialog(
      {
        title: `Delete the learning path "${summary.title}"?`,
        content: (content, contentSignal) => {
          content.append(element(document, "h2", "lp-dialog-title", summary.title));
          content.append(
            element(
              document,
              "p",
              "lp-dialog-text",
              `This deletes the plugin's path record (${summary.moduleCount} module(s), ${summary.nodeCount} node(s)) ` +
                "and any converted source files that no other path uses.",
            ),
          );
          content.append(
            element(
              document,
              "p",
              "lp-dialog-text lp-dialog-safe",
              "Native LearnHarness chats and Knowledge Graph records are never deleted by this action.",
            ),
          );
          const actions = element(document, "div", "lp-dialog-actions");
          content.append(actions);

          const keepHost = element(document, "span", "lp-button-host");
          actions.append(keepHost);
          ctx.ui.mountButton(
            keepHost,
            {
              label: "Keep path",
              variant: "outline",
              size: "sm",
              onClick: () => dialog?.dispose(),
            },
            { signal: contentSignal },
          );

          const deleteHost = element(document, "span", "lp-button-host");
          actions.append(deleteHost);
          ctx.ui.mountButton(
            deleteHost,
            {
              label: "Delete path",
              variant: "destructive",
              size: "sm",
              onClick: () => {
                dialog?.dispose();
                void deletePath(summary);
              },
            },
            { signal: contentSignal },
          );
        },
      },
      { signal },
    );
    dialogs.push(dialog);
  }

  function renderPaths(): void {
    if (disposed || signal.aborted) return;
    clearPaths();
    if (summaries.length === 0) {
      pathsHost.append(
        element(
          document,
          "p",
          "lp-muted",
          "No learning paths yet. Create one from the Path Hub; native sessions stay untouched here.",
        ),
      );
      return;
    }
    const list = element(document, "ul", "lp-settings-path-list");
    for (const summary of summaries) {
      const item = element(document, "li", "lp-settings-path-row");
      item.dataset.pathId = summary.id;
      const text = element(document, "span", "lp-settings-path-text");
      text.append(element(document, "strong", undefined, summary.title));
      text.append(
        element(
          document,
          "span",
          "lp-muted",
          `${summary.moduleCount} module(s) · ${summary.nodeCount} node(s)`,
        ),
      );
      item.append(text);
      const actions = element(document, "span", "lp-settings-path-actions");
      item.append(actions);
      const host = element(document, "span", "lp-button-host");
      actions.append(host);
      pathHandles.push(
        ctx.ui.mountButton(
          host,
          {
            label: "Delete path…",
            variant: "ghost",
            size: "xs",
            onClick: () => openDeleteDialog(summary),
          },
          { signal },
        ),
      );
      list.append(item);
    }
    pathsHost.append(list);
  }

  async function saveSettings(next: PluginSettings): Promise<boolean> {
    if (disposed || signal.aborted) return false;
    setStatus("Saving…");
    try {
      const result = await ctx.call<SettingsResult>("settings.save", next);
      if (disposed || signal.aborted) return false;
      settings = result.settings;
      showSaved(result.settings, result.modelPending === true);
      return true;
    } catch (problem) {
      if (disposed || signal.aborted) return false;
      setStatus(`Could not save settings: ${errorMessage(problem)}`, "error");
      // Restore the controlled widgets to the last accepted record.
      renderArtifactRows();
      renderArchitect();
      return false;
    }
  }

  function showSaved(saved: PluginSettings, modelPending = false): void {
    settings = saved;
    setStatus(
      modelPending
        ? "Settings saved. The new Architect model applies once the running Architect conversation finishes."
        : "Settings saved.",
    );
    renderArtifactRows();
    renderArchitect();
  }

  async function load(): Promise<void> {
    if (disposed || signal.aborted) return;
    const token = ++loadToken;
    try {
      const [settingsResult, pathsResult] = await Promise.all([
        ctx.call<SettingsResult>("settings.get"),
        ctx.call<PathsResult>("paths.list"),
      ]);
      if (!live(token)) return;
      settings = settingsResult.settings;
      overrideDraft = null;
      summaries = [...(pathsResult.paths ?? [])];
      renderArtifactRows();
      renderArchitect();
      renderPaths();
      setStatus(null);
    } catch (problem) {
      if (!live(token)) return;
      setStatus(`Could not load Learning Path settings: ${errorMessage(problem)}`, "error");
    }
  }

  const offNotification = ctx.onNotification((event) => {
    if (disposed || signal.aborted) return;
    if (event.topic === EVENT_SETTINGS_CHANGED || event.topic === EVENT_PATHS_CHANGED) {
      void load();
    }
  });
  const offResync = ctx.onResync(() => {
    if (disposed || signal.aborted) return;
    void load();
  });

  void load();

  return () => {
    if (disposed) return;
    disposed = true;
    loadToken += 1;
    offNotification();
    offResync();
    for (const handle of dialogs.reverse()) handle.dispose();
    dialogs.length = 0;
    clearArchitect();
    clearPaths();
    artifactRows?.dispose();
    artifactRows = null;
    root.remove();
  };
}
