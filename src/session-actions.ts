/** Learning Path — the single native session action.
 *
 * The host exposes one top-bar placement per action, so the plugin keeps the
 * chrome compact and puts parent navigation, attachment, and lesson handoff
 * choices in one plugin-owned dialog. The host supplies a fresh session view
 * snapshot for each invocation; readiness is deliberately only a heuristic.
 */
import type { PluginActionContext, PluginFrontendContext } from "learnharness-plugin-api";
import { createSessionLauncher } from "./session-launcher.ts";
import type { SessionLauncher } from "./session-launcher.ts";
import { openLearningPathMenuDialog } from "./view/session-dialogs.ts";

export interface SessionActionOptions {
  /** Injectable launcher; production creates one bound to the activation. */
  readonly launcher?: SessionLauncher;
}

function likelyReadyForPath(context: PluginActionContext): boolean {
  return context.surface === "session" &&
    context.kind === "teaching" &&
    !context.view.busy &&
    context.view.status === "ready" &&
    context.view.phase === "teach";
}

export function registerSessionActions(
  ctx: PluginFrontendContext,
  options: SessionActionOptions = {},
): () => void {
  const launcher = options.launcher ?? createSessionLauncher(ctx);
  const disposers: (() => void)[] = [];

  disposers.push(
    ctx.registerAction({
      id: "lp-learning-path",
      name: "Learning Path",
      run: async (context: PluginActionContext) => {
        if (context.surface !== "session") return;
        openLearningPathMenuDialog(ctx, {
          launcher,
          chatId: context.sessionId,
          kind: context.kind,
          likelyReady: likelyReadyForPath(context),
          signal: ctx.signal,
        });
      },
    }),
  );
  disposers.push(
    ctx.placeAction({
      id: "lp-learning-path-top-bar",
      actionId: "lp-learning-path",
      location: "top-bar",
      sessions: ["teaching", "practice"],
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
