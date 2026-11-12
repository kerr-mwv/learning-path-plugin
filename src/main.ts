/** Learning Path — frontend activation shell.
 * Registers the Path Hub view, session actions/tool cards and the dedicated
 * settings page (artifact defaults, Architect model preference, safe deletion). */
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { registerSessionActions } from "./session-actions.ts";
import { mountSettingsPage } from "./settings.ts";
import { mountPathHub } from "./view/path-hub.ts";
import { registerLearningPathToolRenderers } from "./view/tool-renderers.ts";

export function activate(ctx: PluginFrontendContext): () => void {
  const disposers: (() => void)[] = [];

  disposers.push(
    ctx.registerView({
      id: "paths",
      name: "Learning Paths",
      mount(container, signal) {
        container.classList.add("learning-path-view");
        const cleanup = mountPathHub(ctx, container, signal);
        return () => {
          cleanup();
          container.replaceChildren();
          container.classList.remove("learning-path-view");
        };
      },
    }),
  );

  disposers.push(
    ctx.registerAction({
      id: "open-paths",
      name: "Open Learning Paths",
      run: () => ctx.app.openView("paths"),
    }),
  );
  disposers.push(ctx.placeAction({ id: "paths-sidebar", actionId: "open-paths", location: "sidebar" }));

  // Session top-bar actions and compact learning_path_* result cards.
  disposers.push(registerSessionActions(ctx));
  disposers.push(registerLearningPathToolRenderers(ctx));

  disposers.push(
    ctx.registerSettings((settingsContainer, settingsSignal) => {
      settingsContainer.classList.add("learning-path-settings");
      const cleanup = mountSettingsPage(ctx, settingsContainer, settingsSignal);
      return () => {
        cleanup();
        settingsContainer.replaceChildren();
        settingsContainer.classList.remove("learning-path-settings");
      };
    }),
  );

  // Registrations expire with the activation; release them explicitly for symmetry.
  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
