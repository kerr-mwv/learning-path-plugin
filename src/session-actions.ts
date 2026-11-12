/** Learning Path — session top-bar actions.
 *
 * Two registered actions, each explicitly placed on native teaching and practice
 * top bars:
 * - "Open Parent Learning Path" resolves the native chat to its Path Node,
 *   hands the node to the Path Hub and navigates there;
 * - "Attach Session to Path…" opens a dialog that links the current chat to a
 *   learner-chosen node.
 *
 * Registration alone creates no chrome; placement is explicit. The host owns
 * busy/error handling, so `run` rejects honestly instead of hiding failures.
 */
import type { PluginActionContext, PluginFrontendContext } from "learnharness-plugin-api";
import { createSessionLauncher } from "./session-launcher.ts";
import type { SessionLauncher } from "./session-launcher.ts";
import { requestPathHubTarget } from "./session-navigation.ts";
import type { SessionParentResult } from "./session-types.ts";
import { openAttachSessionDialog } from "./view/session-dialogs.ts";

export interface SessionActionOptions {
  /** Injectable launcher; production creates one bound to the activation. */
  readonly launcher?: SessionLauncher;
}

export function registerSessionActions(
  ctx: PluginFrontendContext,
  options: SessionActionOptions = {},
): () => void {
  const launcher = options.launcher ?? createSessionLauncher(ctx);
  const disposers: (() => void)[] = [];

  disposers.push(
    ctx.registerAction({
      id: "lp-open-parent-learning-path",
      name: "Open Parent Learning Path",
      run: async (context: PluginActionContext) => {
        if (context.surface !== "session") return;
        let parent: SessionParentResult["link"] = null;
        try {
          const result = await ctx.call<SessionParentResult>("sessions.forChat", {
            chatId: context.sessionId,
          });
          parent = result.link;
        } catch {
          // A missing/unlinked chat still opens the hub, where the learner can attach it.
        }
        if (parent) {
          requestPathHubTarget({ pathId: parent.pathId, nodeId: parent.nodeId });
        }
        ctx.app.openView("paths");
      },
    }),
  );
  disposers.push(
    ctx.placeAction({
      id: "lp-open-parent-top-bar",
      actionId: "lp-open-parent-learning-path",
      location: "top-bar",
      sessions: ["teaching", "practice"],
    }),
  );

  disposers.push(
    ctx.registerAction({
      id: "lp-attach-session-to-path",
      name: "Attach Session to Path…",
      run: async (context: PluginActionContext) => {
        if (context.surface !== "session") return;
        openAttachSessionDialog(ctx, {
          launcher,
          chatId: context.sessionId,
          kind: context.kind,
          signal: ctx.signal,
        });
      },
    }),
  );
  disposers.push(
    ctx.placeAction({
      id: "lp-attach-session-top-bar",
      actionId: "lp-attach-session-to-path",
      location: "top-bar",
      sessions: ["teaching", "practice"],
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
