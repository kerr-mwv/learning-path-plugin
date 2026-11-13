/** Read-only draft discovery before a path has server-assigned unit IDs. */
import type { PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import type { KnowledgeDiscovery } from "../knowledge.ts";

export function openDraftKnowledgeDialog(ctx: PluginFrontendContext, signal: AbortSignal): void {
  ctx.ui.openDialog({
    title: "Check a draft against existing knowledge",
    content(container, contentSignal) {
      const document = container.ownerDocument;
      const root = document.createElement("div"); root.className = "lp-session-dialog";
      const titleLabel = document.createElement("label"); titleLabel.className = "lp-field"; titleLabel.textContent = "Draft unit title";
      const title = document.createElement("input"); title.className = "lp-select"; title.maxLength = 300; titleLabel.append(title);
      const goalLabel = document.createElement("label"); goalLabel.className = "lp-field"; goalLabel.textContent = "Draft unit goal";
      const goal = document.createElement("textarea"); goal.className = "lp-select"; goal.maxLength = 4000; goalLabel.append(goal);
      const status = document.createElement("p"); status.setAttribute("role", "status");
      status.textContent = "Local discovery only. To persist links or rejections, save the draft path, then review its units in the inspector.";
      const error = document.createElement("p"); error.setAttribute("role", "alert");
      const results = document.createElement("div");
      const host = document.createElement("span"); root.append(titleLabel, goalLabel, host, status, error, results); container.append(root);
      let disposed = false, busy = false;
      const live = () => !disposed && !signal.aborted && !contentSignal.aborted;
      let button: PluginWidgetHandle<unknown>;
      button = ctx.ui.mountButton(host, { label: "Check draft knowledge", variant: "outline", size: "sm", onClick: async () => {
        if (!live() || busy) return;
        busy = true; button.update({ disabled: true }); error.textContent = ""; status.textContent = "Checking recorded propositions…";
        try {
          const response = await ctx.call<KnowledgeDiscovery>("knowledge.discover", { draft: { title: title.value.trim(), goal: goal.value.trim() } });
          if (!live()) return;
          results.replaceChildren(); status.textContent = response.notice + (response.truncated ? " Graph scan is limited to 10,000 propositions." : "");
          const matches = response.units.flatMap(unit => unit.candidates);
          if (!matches.length) results.textContent = "No matching candidates found. This is not evidence of a knowledge gap.";
          for (const match of matches) {
            const card = document.createElement("article"); card.className = "lp-knowledge-card";
            const heading = document.createElement("h3"); heading.textContent = match.proposition.name;
            const statement = document.createElement("p"); statement.textContent = match.proposition.statement;
            const rationale = document.createElement("p"); rationale.textContent = match.rationale;
            const provenance = document.createElement("p"); provenance.textContent = `Provenance: ${match.proposition.provenance.slice(0, 20).map(point => `${point.chatId}${point.messageId ? ` / ${point.messageId}` : ""}`).join("; ") || "none recorded"}`;
            card.append(heading, statement, rationale, provenance); results.append(card);
          }
        } catch (problem) {
          if (live()) error.textContent = problem instanceof Error ? problem.message : String(problem);
        } finally {
          if (live()) { busy = false; button.update({ disabled: false }); }
        }
      } }, { signal: contentSignal });
      return () => { disposed = true; button.dispose(); root.remove(); };
    },
  }, { signal });
}
