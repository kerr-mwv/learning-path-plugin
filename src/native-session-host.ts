/** Learning Path — same-window native session creation and opening-prompt staging.
 *
 * The plugin API v1 exposes navigation (`ctx.app.openSession`) and read-only
 * learning data, but no "create a native chat" method. LearnHarness itself
 * creates chats through its same-origin `POST /api/chats` route and hands the
 * first message to the chat page through `sessionStorage` under
 * `lh.openingPrompt.<chatId>`. This module isolates that host boundary:
 *
 * - `POST /api/chats` with `{ title }` (teaching) or `{ title, kind: "practice" }`
 *   returns `{ id, title }`;
 * - the opening prompt is stored as `{ text, attempted: false }` so the chat
 *   page sends it once, then clears it.
 *
 * Everything is injectable so tests never touch the network or real storage.
 * If creation or staging fails, the caller links nothing and can fall back to
 * "Link Existing Session…"; no learner data is deleted.
 */
import type { ChildSessionKind } from "./domain.ts";

export const OPENING_PROMPT_PREFIX = "lh.openingPrompt.";
export const LAUNCH_FAILURE =
  "Could not open the session. You can still attach an existing chat to this node.";

export interface NativeSessionHost {
  create(input: { readonly title: string; readonly kind: ChildSessionKind }): Promise<{ chatId: string }>;
  /** Returns false when storage is unavailable, so the caller does not link blindly. */
  stageOpeningPrompt(chatId: string, text: string): boolean;
  clearOpeningPrompt(chatId: string): void;
}

export interface BrowserSessionHostOptions {
  readonly fetch?: typeof fetch;
  readonly storage?: Storage;
}

const CHAT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function storageOrNull(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** The real host adapter used by the plugin activation. */
export function createBrowserSessionHost(
  options: BrowserSessionHostOptions = {},
): NativeSessionHost {
  const fetchImpl =
    options.fetch ??
    (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
  const storage = options.storage ?? storageOrNull();

  return {
    async create({ title, kind }) {
      if (typeof fetchImpl !== "function") throw new Error(LAUNCH_FAILURE);
      const body = kind === "practice" ? { title, kind: "practice" } : { title };
      let response: Response;
      try {
        response = await fetchImpl("/api/chats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch {
        throw new Error(LAUNCH_FAILURE);
      }
      if (!response.ok) throw new Error(LAUNCH_FAILURE);
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error(LAUNCH_FAILURE);
      }
      const chatId =
        payload !== null && typeof payload === "object" && "id" in payload
          ? (payload as { id?: unknown }).id
          : undefined;
      if (typeof chatId !== "string" || !CHAT_ID_PATTERN.test(chatId)) {
        throw new Error(LAUNCH_FAILURE);
      }
      return { chatId };
    },

    stageOpeningPrompt(chatId, text) {
      if (!storage) return false;
      try {
        const value = JSON.stringify({ text, attempted: false });
        storage.setItem(`${OPENING_PROMPT_PREFIX}${chatId}`, value);
        return storage.getItem(`${OPENING_PROMPT_PREFIX}${chatId}`) === value;
      } catch {
        return false;
      }
    },

    clearOpeningPrompt(chatId) {
      if (!storage) return;
      try {
        storage.removeItem(`${OPENING_PROMPT_PREFIX}${chatId}`);
      } catch {
        // The canonical transcript/acknowledgment remains the truth.
      }
    },
  };
}
