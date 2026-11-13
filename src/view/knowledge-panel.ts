/** Host-widget knowledge review. Every mutation requires a learner click. */
import type { GraphNode, PluginFrontendContext, PluginWidgetHandle } from "learnharness-plugin-api";
import type { LearningPath, PathNode } from "../domain.ts";
import type { KnowledgeCandidate, KnowledgeDiscovery, KnowledgeInspection } from "../knowledge.ts";
import { EVENT_PATHS_CHANGED } from "../topics.ts";
const RELATIONSHIPS = ["related", "covers", "requires"] as const;

function el<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function value(select: HTMLSelectElement): string {
  return select.value || [...select.options].find(option => option.selected)?.value || select.options[0]?.value || "";
}
export function createKnowledgePanel(ctx: PluginFrontendContext, container: HTMLElement, signal: AbortSignal, path: LearningPath, node: PathNode): () => void {
  const document = container.ownerDocument;
  const handles: PluginWidgetHandle<unknown>[] = [];
  let disposed = false, generation = 0, busy = false;
  let mode: "confirmed" | "review" = "confirmed";
  let knowledgeDirty = false;
  const live = (token = generation) => !disposed && !signal.aborted && token === generation;
  const scope = { pathId: path.id, nodeId: node.id };
  const status = el(document, "p", "Load confirmed links, search manually, or check this unit for related recorded knowledge.", "lp-muted");
  status.setAttribute("role", "status");
  const error = el(document, "p", "", "lp-dialog-error");
  error.hidden = true;
  error.setAttribute("role", "alert");
  const results = el(document, "div", undefined, "lp-knowledge-results");
  const controls = el(document, "div", undefined, "lp-chat-actions");
  const searchLabel = el(document, "label", undefined, "lp-field");
  searchLabel.append(el(document, "span", "Find a proposition", "lp-field-label"));
  const query = el(document, "input", undefined, "lp-select");
  query.type = "search"; query.maxLength = 300;
  searchLabel.append(query);
  container.append(status, controls, searchLabel, error, results);
  const button = (parent: HTMLElement, label: string, action: () => Promise<void>) => {
    const host = el(document, "span", undefined, "lp-button-host"); parent.append(host);
    const handle = ctx.ui.mountButton(host, { label, size: "xs", variant: "outline", onClick: () => {
      if (!live() || busy) return;
      busy = true;
      for (const handle of handles) handle.update({ disabled: true });
      error.textContent = ""; error.hidden = true; status.textContent = "Loading…";
      void action().catch(problem => {
        if (live()) {
          error.textContent = problem instanceof Error ? problem.message : String(problem); error.hidden = false;
          status.textContent = "The action could not be completed. Your path is unchanged; refresh or retry.";
        }
      })
        .finally(() => { if (live()) { busy = false; for (const handle of handles) handle.update({ disabled: false }); if (mode === "confirmed" && knowledgeDirty) void inspect().catch(() => {}); } });
    } }, { signal });
    handles.push(handle);
  };
  const showProposition = (parent: HTMLElement, proposition: GraphNode) => {
    parent.append(el(document, "strong", proposition.name), el(document, "p", proposition.statement));
    const details = el(document, "details"); details.append(el(document, "summary", "Aliases and provenance"));
    details.append(el(document, "p", proposition.aliases.length ? proposition.aliases.join(" · ") : "No recorded aliases."));
    const list = el(document, "ul", undefined, "lp-link-list");
    for (const point of proposition.provenance.slice(0, 20)) {
      const item = el(document, "li", `${point.chatId.startsWith("src_") ? "Notes source" : "Session"}: ${point.chatId}${point.messageId ? ` · message: ${point.messageId}` : " (source-level provenance)"}`); list.append(item);
    }
    if (proposition.provenance.length > 20) list.append(el(document, "li", `${proposition.provenance.length - 20} additional provenance records not shown.`));
    if (!proposition.provenance.length) list.append(el(document, "li", "No provenance recorded."));
    details.append(list); parent.append(details);
  };
  const clearResults = () => {
    // Result widgets use the same mount signal but are explicitly released on refresh.
    for (const handle of handles.splice(4)) handle.dispose();
    results.replaceChildren();
  };
  const candidate = (parent: HTMLElement, match: KnowledgeCandidate, origin: "manual" | "suggested", targetNodeId = node.id) => {
    const targetScope = { pathId: path.id, nodeId: targetNodeId };
    const card = el(document, "article", undefined, "lp-knowledge-card"); parent.append(card);
    showProposition(card, match.proposition);
    card.append(el(document, "p", match.rationale, "lp-muted"));
    const relationLabel = el(document, "label", undefined, "lp-field");
    relationLabel.append(el(document, "span", "Relationship (your assessment)", "lp-field-label"));
    const relation = el(document, "select", undefined, "lp-select");
    for (const key of RELATIONSHIPS) {
      const option = el(document, "option", key === "covers" ? "Covers this unit (assess extent below)" : key === "requires" ? "Prerequisite for this unit" : "Related context (unassessed)");
      option.value = key; option.selected = key === "related"; relation.append(option);
    }
    relationLabel.append(relation);
    const coverageLabel = el(document, "label", undefined, "lp-field");
    coverageLabel.append(el(document, "span", "Coverage extent (not mastery)", "lp-field-label"));
    const coverage = el(document, "select", undefined, "lp-select");
    for (const [key, label] of [["unassessed", "Unassessed"], ["partial", "Part of this unit"], ["full", "Whole unit (your assessment)"]] as const) {
      const option = el(document, "option", label); option.value = key; coverage.append(option);
    }
    coverage.disabled = true;
    relation.addEventListener("change", () => { coverage.disabled = value(relation) !== "covers"; });
    coverageLabel.append(coverage);
    const rationaleLabel = el(document, "label", undefined, "lp-field");
    rationaleLabel.append(el(document, "span", "Why link it?", "lp-field-label"));
    const rationale = el(document, "textarea", undefined, "lp-select"); rationale.maxLength = 2000; rationale.value = match.rationale;
    rationaleLabel.append(rationale); card.append(relationLabel, coverageLabel, rationaleLabel);
    const actions = el(document, "div", undefined, "lp-chat-actions"); card.append(actions);
    button(actions, `Confirm link: ${match.proposition.name}`, async () => {
      await ctx.call("knowledge.link", { ...targetScope, graphNodeId: match.proposition.id, fingerprint: match.fingerprint,
        relationship: value(relation), coverage: value(relation) === "covers" ? value(coverage) : "unassessed", rationale: rationale.value.trim(), origin });
      if (live()) { card.remove(); status.textContent = "Link confirmed. Progression is unchanged."; }
    });
    button(actions, `Reject match: ${match.proposition.name}`, async () => {
      await ctx.call("knowledge.reject", { ...targetScope, graphNodeId: match.proposition.id, fingerprint: match.fingerprint });
      if (live()) { card.remove(); status.textContent = "Match rejected until the unit or proposition meaning changes."; }
    });
  };
  const inspect = async () => {
    mode = "confirmed";
    knowledgeDirty = false;
    const token = ++generation;
    const response = await ctx.call<KnowledgeInspection>("knowledge.inspect", scope);
    if (!live(token)) return;
    clearResults(); status.textContent = response.notice;
    if (!response.links.length) results.append(el(document, "p", "No confirmed graph links for this unit."));
    for (const entry of response.links) {
      const card = el(document, "article", undefined, "lp-knowledge-card"); results.append(card);
      if (entry.proposition) showProposition(card, entry.proposition);
      else card.append(el(document, "p", `${response.available ? "Missing proposition" : "Unresolved while graph unavailable"}: ${entry.link.graphNodeId}`));
      card.append(el(document, "p", `${entry.link.relationship} · coverage ${entry.link.coverage} · ${entry.link.origin} · confirmed ${entry.link.confirmedAt} · ${entry.link.rationale}`));
      button(card, `Unlink ${entry.proposition?.name ?? entry.link.graphNodeId}`, async () => {
        await ctx.call("knowledge.unlink", { ...scope, graphNodeId: entry.link.graphNodeId });
        if (live()) { card.remove(); status.textContent = "Association removed. Native knowledge is untouched."; }
      });
    }
  };
  button(controls, "Show confirmed knowledge", inspect);
  const discovery = async (wholePath: boolean) => {
    mode = "review";
    const token = ++generation;
    const response = await ctx.call<KnowledgeDiscovery>("knowledge.discover", wholePath ? { pathId: path.id } : scope);
    if (!live(token)) return;
    clearResults(); status.textContent = `${response.notice}${response.truncated ? " Results are bounded; search individual units or propositions for additional material." : ""}`;
    if (!response.units.some(unit => unit.candidates.length)) results.append(el(document, "p", "No new matching candidates found. This does not establish a knowledge gap."));
    for (const unit of response.units) {
      const section = el(document, "section"); section.append(el(document, "h4", unit.title)); results.append(section);
      for (const match of unit.candidates) candidate(section, match, "suggested", unit.nodeId);
    }
  };
  button(controls, "Check existing knowledge", () => discovery(false));
  button(controls, "Check whole path", () => discovery(true));
  button(searchLabel, "Search propositions", async () => {
    mode = "review";
    const token = ++generation;
    const response = await ctx.call<{ propositions: GraphNode[]; notice: string; truncated: boolean }>("knowledge.search", { query: query.value.trim() });
    if (!live(token)) return;
    clearResults(); status.textContent = response.notice + (response.truncated ? " Graph scan limited to 10,000 propositions." : "");
    if (!response.propositions.length) results.append(el(document, "p", "No matching propositions found. Try a different phrase or exact ID."));
    for (const proposition of response.propositions) {
      const preview = await ctx.call<{ proposition: GraphNode; fingerprint: string }>("knowledge.preview", { ...scope, graphNodeId: proposition.id });
      if (!live(token)) return;
      candidate(results, { ...preview, relationship: "related", coverage: "unassessed", rationale: "Manually selected recorded proposition; coverage is unassessed." }, "manual");
    }
  });
  const offKnowledge = ctx.onNotification(event => {
    if (!live() || event.topic !== EVENT_PATHS_CHANGED || (event.data as { knowledgeChanged?: unknown } | undefined)?.knowledgeChanged !== true) return;
    knowledgeDirty = true;
    if (mode === "confirmed" && !busy) {
      void inspect().catch(() => { if (live()) status.textContent = "Knowledge changed; retry Show confirmed knowledge to refresh."; });
    } else if (mode === "review") {
      status.textContent = "Knowledge links changed. Remaining review choices are preserved; Show confirmed knowledge refreshes saved associations.";
    }
  });
  void inspect().then(() => {
    if (live()) for (const handle of handles) handle.update({ disabled: busy });
  }).catch(problem => {
    if (live()) { error.textContent = problem instanceof Error ? problem.message : String(problem); error.hidden = false; status.textContent = "Knowledge links could not be loaded. Your path is unchanged; retry Show confirmed knowledge."; }
  });
  return () => { disposed = true; generation += 1; offKnowledge(); for (const handle of handles.reverse()) handle.dispose(); };
}
