/** Learning Path — opens/creates/links native child chats.
 *
 * Flow for "Start Teaching/Practice Chat":
 *   1. backend `sessions.prepare` builds the node's tailored opening prompt;
 *   2. the host creates a native chat through the isolated session host;
 *   3. the prompt is staged for the chat page (before navigating);
 *   4. backend `sessions.link` records the ChildSessionLink;
 *   5. `ctx.app.openSession` navigates to the now-linked chat.
 *
 * If staging fails before linking, the native chat exists but stays unlinked:
 * the caller reports the failure and the learner can use "Link Existing
 * Session…". If linking fails after staging, the staged prompt is cleared so a
 * later click cannot auto-send a brief into an unlinked session.
 */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import type { ChildSessionKind } from "./domain.ts";
import { LAUNCH_FAILURE, createBrowserSessionHost } from "./native-session-host.ts";
import type { NativeSessionHost } from "./native-session-host.ts";
import type {
  AvailableSession,
  PreparedLaunch,
  SessionLinkResult,
} from "./session-types.ts";

export interface StartChildSessionInput {
  readonly pathId: string;
  readonly nodeId: string;
  readonly kind: ChildSessionKind;
}

export interface AttachChildSessionInput {
  readonly pathId: string;
  readonly nodeId: string;
  readonly chatId: string;
  readonly kind: ChildSessionKind;
  readonly label?: string;
}

export interface StartedChildSession {
  readonly chatId: string;
  readonly link: SessionLinkResult["link"];
  readonly path: SessionLinkResult["path"];
  readonly prepared: PreparedLaunch;
}

export interface SessionLauncherOptions {
  /** Injectable host boundary; defaults to the same-origin browser adapter. */
  readonly host?: NativeSessionHost;
}

export interface SessionLauncher {
  start(input: StartChildSessionInput): Promise<StartedChildSession>;
  attach(input: AttachChildSessionInput): Promise<SessionLinkResult>;
  available(): Promise<readonly AvailableSession[]>;
  /** Open an already-linked native chat; navigation only, no model work. */
  open(chatId: string): void;
}

export function createSessionLauncher(
  ctx: PluginFrontendContext,
  options: SessionLauncherOptions = {},
): SessionLauncher {
  const host = options.host ?? createBrowserSessionHost();

  return {
    async start(input) {
      const prepared = await ctx.call<PreparedLaunch>("sessions.prepare", {
        pathId: input.pathId,
        nodeId: input.nodeId,
        kind: input.kind,
      });
      const created = await host.create({ title: prepared.title, kind: input.kind });
      if (!host.stageOpeningPrompt(created.chatId, prepared.prompt)) {
        // No link was written, so the untouched chat is safe to leave for reuse.
        throw new Error(
          `${LAUNCH_FAILURE} The session was created, but the opening brief could not be staged.`,
        );
      }
      let linked: SessionLinkResult;
      try {
        linked = await ctx.call<SessionLinkResult>("sessions.link", {
          pathId: input.pathId,
          nodeId: input.nodeId,
          chatId: created.chatId,
          kind: input.kind,
          label: prepared.title,
        });
      } catch (error) {
        host.clearOpeningPrompt(created.chatId);
        throw error;
      }
      ctx.app.openSession(created.chatId);
      return { chatId: created.chatId, link: linked.link, path: linked.path, prepared };
    },

    async attach(input) {
      return ctx.call<SessionLinkResult>("sessions.link", {
        pathId: input.pathId,
        nodeId: input.nodeId,
        chatId: input.chatId,
        kind: input.kind,
        ...(input.label === undefined ? {} : { label: input.label }),
      });
    },

    async available() {
      const result = await ctx.call<{ sessions: readonly AvailableSession[] }>(
        "sessions.available",
      );
      return result.sessions ?? [];
    },

    open(chatId) {
      ctx.app.openSession(chatId);
    },
  };
}
