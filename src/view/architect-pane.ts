/** Architect Chat surface for the Path Hub.
 *
 * The pane owns conversation state, not persistence: every command goes through
 * the plugin backend (`architect.*`, `sources.save`) and the view feeds
 * authoritative snapshots back in after notifications or `onResync`.
 *
 * Host controls used here:
 * - `ctx.ui.mountStandardComposer` for the model/thinking/composer/dictation set;
 * - `ctx.ui.mountMarkdown` for every assistant turn;
 * - `ctx.ui.mountButton` for the PDF/UTF-8 upload trigger.
 * All handles are scoped to the per-mount `AbortSignal` and disposed on unmount.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ArchitectProgress } from "../topics.ts";
import type {
  PluginAgentSnapshot,
  PluginFrontendContext,
  PluginModelValue,
  PluginStandardComposerProps,
  PluginWidgetHandle,
} from "learnharness-plugin-api";

export interface ArchitectPane {
  readonly element: HTMLElement;
  /** Open a fresh draft so the learner can choose a model before the first send. */
  startNew(): void;
  /** Re-read one conversation snapshot after a notification or resync. */
  load(conversationId: string): Promise<void>;
  /** Apply a change notification: when the committed history is unchanged
   * (`messageCount` matches), read only live progress; otherwise reload. */
  refresh(conversationId: string, messageCount?: number): Promise<void>;
  /** Adopt an already authoritative snapshot (from `architect.create/send/get`). */
  setConversation(snapshot: PluginAgentSnapshot | null): void;
  /** Open a conversation if needed, then send a plugin-authored prompt. */
  discuss(text: string): Promise<void>;
  conversationId(): string | null;
  /** Whether the user has explicitly opened a fresh unsent draft. */
  isNewDraft(): boolean;
  /** Convert and store one uploaded PDF/UTF-8 document. */
  uploadFile(file: File): Promise<void>;
  dispose(): void;
}

interface TextPart {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly thinking?: unknown;
  readonly name?: unknown;
}

function requestId(): string {
  const crypto = globalThis.crypto;
  if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return typeof error === "string" && error.trim() ? error : "Unexpected error.";
}

function messageText(message: unknown): string | null {
  if (message === null || typeof message !== "object") return null;
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "user" && record.role !== "assistant") return null;
  const content = record.content;
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter((part): part is TextPart => part !== null && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
  return text || null;
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

export function createArchitectPane(
  ctx: PluginFrontendContext,
  container: HTMLElement,
  signal: AbortSignal,
): ArchitectPane {
  const document = container.ownerDocument;
  const root = element(document, "section", "lp-architect");
  root.setAttribute("aria-label", "Path Architect");

  const headingRow = element(document, "div", "lp-pane-heading");
  headingRow.append(element(document, "h2", "lp-pane-title", "Path Architect"));
  const status = element(document, "p", "lp-architect-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  headingRow.append(status);
  root.append(headingRow);

  const log = element(document, "div", "lp-chat-log");
  log.setAttribute("aria-label", "Architect conversation");
  // Committed history is re-rendered only when it changes; the streamed partial
  // lives in its own section so progress ticks never remount the whole log.
  const history = element(document, "div", "lp-chat-history");
  const live = element(document, "div", "lp-chat-live");
  const emptyChat = element(document, "p", "lp-empty-chat",
    "Describe your goal and background. A source is optional; you can also upload a PDF or text. The Architect will propose a path.");
  log.append(history, live, emptyChat);
  root.append(log);

  const uploadRow = element(document, "div", "lp-upload-row");
  const uploadHost = element(document, "span", "lp-button-host");
  uploadRow.append(uploadHost);
  const uploadStatus = element(document, "p", "lp-upload-status");
  uploadStatus.setAttribute("role", "status");
  uploadStatus.setAttribute("aria-live", "polite");
  uploadRow.append(uploadStatus);
  const fileInput = element(document, "input", "lp-file-input");
  fileInput.type = "file";
  fileInput.accept = ".pdf,.md,.markdown,.txt,.text,application/pdf,text/plain,text/markdown";
  fileInput.hidden = true;
  fileInput.setAttribute("aria-label", "Upload a PDF or UTF-8 text source");
  uploadRow.append(fileInput);
  root.append(uploadRow);

  const modelHint = element(document, "p", "lp-model-hint");
  root.append(modelHint);
  const composerHost = element(document, "div", "lp-composer-host");
  root.append(composerHost);
  container.append(root);

  let conversation: PluginAgentSnapshot | null = null;
  let draft = "";
  let model: PluginModelValue | undefined;
  let thinking: ThinkingLevel | undefined;
  let sending = false;
  let creating = false;
  let uploading = false;
  let error: string | null = null;
  let historyHandles: PluginWidgetHandle<unknown>[] = [];
  let liveHandles: PluginWidgetHandle<unknown>[] = [];
  let renderedHistoryKey: string | null = null;
  let historyTurns = 0;
  let disposed = false;
  let loadVersion = 0;
  let newDraft = false;

  const uploadButton = ctx.ui.mountButton(
    uploadHost,
    {
      label: "Upload PDF or text",
      variant: "outline",
      size: "sm",
      onClick: () => {
        if (!signal.aborted && !disposed && !uploading) fileInput.click();
      },
    },
    { signal },
  );

  const busy = (): boolean => creating || sending || conversation?.status === "running";

  const composerProps = (): PluginStandardComposerProps => ({
    composer: {
      value: draft,
      onChange: (value) => {
        if (signal.aborted || disposed) return;
        draft = value;
        updateComposer();
      },
      onSend: () => {
        void send();
      },
      onStop: () => {
        void stop();
      },
      busy: busy(),
      canSend: draft.trim().length > 0,
      placeholder: conversation
        ? "Refine the path, or ask what to study next…"
        : "Describe your goal and background (source optional)…",
    },
    model: {
      value: model,
      disabled: busy() || conversation !== null,
      onChange: (value) => {
        if (signal.aborted || disposed || conversation) return;
        model = value;
        thinking = undefined; // a different model may not support the previous level
        updateComposer();
      },
    },
    thinking: {
      model,
      value: thinking,
      disabled: busy() || conversation !== null || model === undefined,
      onChange: (value) => {
        if (signal.aborted || disposed || conversation) return;
        thinking = value;
        updateComposer();
      },
    },
    dictation: {
      disabled: busy(),
      onTranscript: (text) => {
        if (signal.aborted || disposed) return;
        draft = draft.length === 0 ? text : `${draft} ${text}`;
        updateComposer();
      },
    },
  });

  let composerHandle: PluginWidgetHandle<PluginStandardComposerProps> | null = null;

  function updateComposer(): void {
    if (disposed || signal.aborted) return;
    modelHint.textContent = conversation
      ? "All Architect conversations share one model. Choosing a different model in Create a Path switches it for every conversation's later messages."
      : model
        ? `New Architect conversation: ${model.provider}:${model.id}${thinking ? ` · ${thinking} thinking` : ""}.`
        : "Choose an Architect model below, or use the configured default (host strong slot or plugin override). The choice applies when you send your first message.";
    composerHandle?.update(composerProps());
  }

  function renderStatus(): void {
    if (disposed || signal.aborted) return;
    status.className = "lp-architect-status";
    if (error) {
      status.textContent = error;
      status.classList.add("lp-status-error");
      return;
    }
    if (creating || sending || conversation?.status === "running") {
      status.textContent = creating ? "Starting Architect…" : "Architect is thinking…";
      status.classList.add("lp-status-busy");
      return;
    }
    if (conversation?.status === "error") {
      status.textContent = conversation.error ?? "The Architect stopped with an error.";
      status.classList.add("lp-status-error");
      return;
    }
    if (conversation?.status === "waiting") {
      status.textContent = "The Architect is waiting for your input.";
      return;
    }
    if (conversation?.status === "interrupted") {
      status.textContent = "Stopped. Continue when you are ready.";
      return;
    }
    status.textContent = conversation
      ? "Ready. Ask for a new path or refine the current one."
      : "Start a conversation to create a path.";
  }

  function disposeHandles(handles: PluginWidgetHandle<unknown>[]): void {
    for (const handle of handles.reverse()) handle.dispose();
  }

  function clearMessages(): void {
    disposeHandles(historyHandles);
    disposeHandles(liveHandles);
    historyHandles = [];
    liveHandles = [];
    history.replaceChildren();
    live.replaceChildren();
    renderedHistoryKey = null;
    historyTurns = 0;
  }

  function appendTurn(
    target: HTMLElement,
    handles: PluginWidgetHandle<unknown>[],
    role: "user" | "assistant",
    text: string,
    partial = false,
  ): void {
    const article = element(
      document,
      "article",
      `lp-chat-turn lp-chat-${role}${partial ? " lp-chat-partial" : ""}`,
    );
    article.dataset.role = role;
    article.append(
      element(document, "span", "lp-chat-role", role === "user" ? "You" : "Architect"),
    );
    if (role === "assistant") {
      const host = element(document, "div", "lp-chat-markdown");
      article.append(host);
      handles.push(ctx.ui.mountMarkdown(host, { text }, { signal }));
    } else {
      article.append(element(document, "p", "lp-chat-text", text));
    }
    target.append(article);
  }

  /** Reasoning and tool activity. Streaming parts read as in progress; committed
   * ones read as finished, with reasoning collapsed so history stays scannable. */
  function appendProgress(target: HTMLElement, message: unknown, streaming: boolean): number {
    if (!message || typeof message !== "object") return 0;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return 0;
    let count = 0;
    for (const part of content as TextPart[]) {
      if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) {
        if (streaming) {
          const block = element(document, "div", "lp-chat-reasoning");
          block.append(element(document, "span", "lp-chat-role", "Architect reasoning"));
          block.append(element(document, "p", "lp-chat-text", part.thinking));
          target.append(block);
        } else {
          const block = element(document, "details", "lp-chat-reasoning");
          block.append(element(document, "summary", "lp-chat-role", "Architect reasoning"));
          block.append(element(document, "p", "lp-chat-text", part.thinking));
          target.append(block);
        }
        count++;
      } else if (part?.type === "toolCall" && typeof part.name === "string") {
        target.append(
          element(document, "p", "lp-chat-activity", streaming ? `Using ${part.name}…` : `Used ${part.name}`),
        );
        count++;
      }
    }
    return count;
  }

  function renderHistory(): number {
    disposeHandles(historyHandles);
    historyHandles = [];
    history.replaceChildren();
    let turns = 0;
    for (const message of conversation?.messages ?? []) {
      if ((message as { role?: string }).role === "assistant") {
        turns += appendProgress(history, message, false);
      }
      const text = messageText(message);
      if (!text) continue;
      const role = (message as { role: string }).role === "user" ? "user" : "assistant";
      appendTurn(history, historyHandles, role, text);
      turns += 1;
    }
    return turns;
  }

  function renderLive(): number {
    disposeHandles(liveHandles);
    liveHandles = [];
    live.replaceChildren();
    if (!conversation?.partial) return 0;
    let turns = appendProgress(live, conversation.partial, true);
    const text = messageText(conversation.partial);
    if (text) {
      appendTurn(live, liveHandles, "assistant", text, true);
      turns += 1;
    }
    return turns;
  }

  function renderMessages(): void {
    if (disposed || signal.aborted) return;
    // Committed messages are append-only, so id + count identifies the history.
    const key = conversation ? `${conversation.id}:${conversation.messages.length}` : "";
    if (key !== renderedHistoryKey) {
      historyTurns = renderHistory();
      renderedHistoryKey = key;
    }
    const liveTurns = renderLive();
    emptyChat.hidden = historyTurns + liveTurns > 0;
  }

  function setConversation(snapshot: PluginAgentSnapshot | null): void {
    if (disposed || signal.aborted) return;
    ++loadVersion;
    conversation = snapshot;
    error = null;
    renderMessages();
    renderStatus();
    updateComposer();
  }

  function startNew(): void {
    if (signal.aborted || disposed) return;
    if (busy()) {
      error = "Stop the current Architect run before starting a new path.";
      renderStatus();
      return;
    }
    // Do not allocate a conversation until the learner has chosen the model.
    newDraft = true;
    if (conversation) {
      draft = "";
      model = undefined;
      thinking = undefined;
    }
    setConversation(null);
  }

  async function create(): Promise<string | null> {
    if (signal.aborted || disposed || creating) return null;
    creating = true;
    error = null;
    renderStatus();
    updateComposer();
    try {
      const result = await ctx.call<{ conversation: PluginAgentSnapshot }>("architect.create", {
        requestId: requestId(),
        ...(model
          ? {
              model: {
                provider: model.provider,
                id: model.id,
                ...(thinking === undefined ? {} : { thinkingLevel: thinking }),
              },
            }
          : {}),
      });
      if (signal.aborted || disposed) return null;
      newDraft = false;
      setConversation(result.conversation);
      return result.conversation.id;
    } catch (problem) {
      if (signal.aborted || disposed) return null;
      error = `Could not start the Architect: ${errorMessage(problem)}`;
      renderStatus();
      return null;
    } finally {
      creating = false;
      renderStatus();
      updateComposer();
    }
  }

  async function load(conversationId: string): Promise<void> {
    if (signal.aborted || disposed) return;
    const version = ++loadVersion;
    try {
      const result = await ctx.call<{ conversation: PluginAgentSnapshot }>("architect.get", {
        id: conversationId,
      });
      if (signal.aborted || disposed || version !== loadVersion) return;
      model = undefined;
      thinking = undefined;
      newDraft = false;
      setConversation(result.conversation);
    } catch (problem) {
      if (signal.aborted || disposed || version !== loadVersion) return;
      error = `Could not load the Architect conversation: ${errorMessage(problem)}`;
      renderStatus();
    }
  }

  async function refresh(conversationId: string, messageCount?: number): Promise<void> {
    if (signal.aborted || disposed) return;
    const current = conversation;
    if (!current || current.id !== conversationId || messageCount !== current.messages.length) {
      return load(conversationId);
    }
    const version = ++loadVersion;
    try {
      const result = await ctx.call<{ progress: ArchitectProgress }>("architect.progress", {
        id: conversationId,
      });
      if (signal.aborted || disposed || version !== loadVersion) return;
      const progress = result.progress;
      // History moved on (or the conversation changed) between the hint and the read.
      if (conversation !== current || progress.messageCount !== current.messages.length) {
        return load(conversationId);
      }
      const { partial: _partial, error: _error, ...committed } = current;
      setConversation({
        ...committed,
        status: progress.status,
        pending: progress.pending,
        updatedAt: progress.updatedAt,
        ...(progress.error === undefined ? {} : { error: progress.error }),
        ...(progress.partial === undefined ? {} : { partial: progress.partial }),
      });
    } catch (problem) {
      if (signal.aborted || disposed || version !== loadVersion) return;
      error = `Could not load the Architect conversation: ${errorMessage(problem)}`;
      renderStatus();
    }
  }

  async function send(): Promise<void> {
    if (signal.aborted || disposed || busy()) return;
    const text = draft.trim();
    if (!text) return;
    if (!conversation) {
      const id = await create();
      if (!id) return;
    }
    if (!conversation || signal.aborted || disposed) return;
    sending = true;
    error = null;
    renderStatus();
    updateComposer();
    try {
      const result = await ctx.call<{ conversation: PluginAgentSnapshot }>("architect.send", {
        id: conversation.id,
        text,
        requestId: requestId(),
      });
      if (signal.aborted || disposed) return;
      draft = "";
      setConversation(result.conversation);
    } catch (problem) {
      if (signal.aborted || disposed) return;
      error = `Could not send the message: ${errorMessage(problem)}`;
      renderStatus();
    } finally {
      sending = false;
      updateComposer();
    }
  }

  async function discuss(text: string): Promise<void> {
    if (signal.aborted || disposed) return;
    draft = text;
    updateComposer();
    if (!conversation) {
      const id = await create();
      if (!id || signal.aborted || disposed) return;
    }
    if (busy()) return;
    await send();
  }

  async function stop(): Promise<void> {
    if (signal.aborted || disposed || !conversation) return;
    error = null;
    try {
      const result = await ctx.call<{ conversation: PluginAgentSnapshot }>("architect.abort", {
        id: conversation.id,
        requestId: requestId(),
      });
      if (signal.aborted || disposed) return;
      setConversation(result.conversation);
    } catch (problem) {
      if (signal.aborted || disposed) return;
      error = `Could not stop the Architect: ${errorMessage(problem)}`;
      renderStatus();
    }
  }

  async function uploadFile(file: File): Promise<void> {
    if (signal.aborted || disposed || uploading) return;
    uploading = true;
    uploadButton.update({ label: "Upload PDF or text", disabled: true });
    uploadStatus.className = "lp-upload-status";
    delete uploadStatus.dataset.state;
    uploadStatus.textContent = `Converting ${file.name}…`;
    try {
      const converted = await ctx.documents.toMarkdown(file, { signal });
      if (signal.aborted || disposed) return;
      const saved = await ctx.call<{ reference: { name: string }; deduplicated: boolean }>(
        "sources.save",
        { name: converted.name, markdown: converted.markdown },
      );
      if (signal.aborted || disposed) return;
      const notices = converted.notices.length > 0 ? ` ${converted.notices.join(" ")}` : "";
      uploadStatus.textContent = saved.deduplicated
        ? `${saved.reference.name} was already in your sources.${notices}`
        : `Added ${saved.reference.name} to your sources.${notices}`;
      uploadStatus.dataset.state = "success";
    } catch (problem) {
      if (signal.aborted || disposed) return;
      uploadStatus.textContent = `Could not use ${file.name}: ${errorMessage(problem)}`;
      uploadStatus.dataset.state = "error";
    } finally {
      uploading = false;
      if (!signal.aborted && !disposed) uploadButton.update({ disabled: false });
    }
  }

  const onFileChange = (): void => {
    if (signal.aborted || disposed) return;
    const file = fileInput.files?.item(0) ?? null;
    fileInput.value = "";
    if (file) void uploadFile(file);
  };
  fileInput.addEventListener("change", onFileChange, { signal });

  composerHandle = ctx.ui.mountStandardComposer(composerHost, composerProps(), { signal });
  updateComposer();
  renderMessages();
  renderStatus();

  return {
    element: root,
    startNew,
    load,
    refresh,
    setConversation,
    discuss,
    conversationId: () => conversation?.id ?? null,
    isNewDraft: () => newDraft,
    uploadFile,
    dispose() {
      if (disposed) return;
      disposed = true;
      fileInput.removeEventListener("change", onFileChange);
      clearMessages();
      uploadButton.dispose();
      composerHandle?.dispose();
      composerHandle = null;
      root.remove();
    },
  };
}
