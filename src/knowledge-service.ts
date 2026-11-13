/** Public SDK boundary: only the merged graph() projection; never core writes. */
import type { GraphNode, PluginBackendContext } from "learnharness-plugin-api";
import type { LearningPathStore } from "./store.ts";
import type { KnowledgeQuery, KnowledgeRelationship, KnowledgeDiscovery, KnowledgeInspection } from "./knowledge.ts";
import { discoverKnowledge, discoverUnit, KNOWLEDGE_RELATIONSHIPS, matchFingerprint, MAX_DISCOVERY_UNITS, MAX_GRAPH_SCAN, RETRIEVAL_NOTICE } from "./knowledge.ts";

function text(value: unknown, name: string, max = 128): string {
  if (typeof value !== "string" || !value.trim() || value.trim() !== value || value.length > max) throw new Error(`Invalid ${name}.`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
export function readKnowledgeQuery(value: unknown): KnowledgeQuery {
  const v = object(value);
  const anchor = v.sourceAnchor === undefined ? undefined : object(v.sourceAnchor);
  return {
    title: text(v.title, "title", 300), goal: text(v.goal, "goal", 4000),
    ...(anchor ? { sourceAnchor: {
      reference: text(anchor.reference, "reference", 300),
      ...(anchor.chapter === undefined ? {} : { chapter: text(anchor.chapter, "chapter", 300) }),
      ...(anchor.section === undefined ? {} : { section: text(anchor.section, "section", 300) }),
    } } : {}),
  };
}
export function createKnowledgeService(ctx: PluginBackendContext, store: LearningPathStore) {
  const assertLive = () => { if (ctx.signal.aborted) throw new Error("The Learning Path plugin is shutting down."); };
  const nodes = (): GraphNode[] => {
    assertLive();
    // Raw nodes.jsonl contains link-appends. Use the host's merged proposition
    // projection, excluding derived canvas/implication nodes and preserving aliases.
    return ctx.learning.graph().propositions;
  };
  const unit = (input: Record<string, unknown>) => {
    const pathId = text(input.pathId, "pathId"), nodeId = text(input.nodeId, "nodeId");
    const path = store.path(pathId);
    const node = path?.modules.flatMap(module => module.nodes).find(node => node.id === nodeId);
    if (!path || !node) throw new Error("Unknown learning path or unit.");
    return { pathId, nodeId, node };
  };
  const inspect = (input: unknown): KnowledgeInspection => {
    const { pathId, nodeId } = unit(object(input));
    const links = store.knowledge().links.filter(link => link.pathId === pathId && link.pathNodeId === nodeId);
    try {
      const graph = new Map(nodes().map(node => [node.id, node]));
      return { links: links.map(link => ({ link, proposition: graph.get(link.graphNodeId) ?? null })), available: true, notice: RETRIEVAL_NOTICE };
    } catch {
      return { links: links.map(link => ({ link, proposition: null })), available: false, notice: "Knowledge graph is unavailable. Links are preserved; retry later." };
    }
  };
  const discover = (input: unknown): KnowledgeDiscovery => {
    const v = object(input);
    const draft = v.draft === undefined ? undefined : readKnowledgeQuery(v.draft);
    const pathId = draft ? undefined : text(v.pathId, "pathId");
    const path = pathId ? store.path(pathId) : undefined;
    if (!draft && !path) throw new Error("Unknown learning path.");
    const all = path ? (v.nodeId === undefined ? path.modules.flatMap(module => module.nodes) : [unit(v).node]) : [];
    let graph: GraphNode[];
    try { graph = nodes(); } catch {
      return { units: [], notice: "Knowledge graph is unavailable. Your path is unchanged; retry later.", truncated: false };
    }
    const state = store.knowledge();
    if (draft) {
      return { units: [{ nodeId: "", title: draft.title, candidates: discoverKnowledge(draft, graph) }], notice: RETRIEVAL_NOTICE, truncated: graph.length > MAX_GRAPH_SCAN };
    }
    return { units: all.slice(0, MAX_DISCOVERY_UNITS).map(node => ({ nodeId: node.id, title: node.title, candidates: discoverUnit(node, pathId!, graph, state) })),
      notice: RETRIEVAL_NOTICE, truncated: graph.length > MAX_GRAPH_SCAN || all.length > MAX_DISCOVERY_UNITS };
  };
  const search = (input: unknown) => {
    const v = object(input), query = text(v.query, "query", 300).toLowerCase();
    const graph = nodes();
    const candidates = graph.slice(0, MAX_GRAPH_SCAN).filter(node => `${node.id} ${node.name} ${node.statement} ${node.aliases.join(" ")}`.toLowerCase().includes(query)).slice(0, 20);
    return { propositions: candidates, truncated: graph.length > MAX_GRAPH_SCAN, notice: "Manual local search (up to 20 results); inspect statements and provenance before linking." };
  };
  const mutate = (input: unknown, action: "link" | "unlink" | "reject") => {
    assertLive();
    const v = object(input), { pathId, nodeId, node } = unit(v), graphNodeId = text(v.graphNodeId, "graphNodeId");
    const state = store.knowledge();
    const same = (entry: { pathId: string; pathNodeId: string; graphNodeId: string }) => entry.pathId === pathId && entry.pathNodeId === nodeId && entry.graphNodeId === graphNodeId;
    if (action === "unlink") {
      store.saveKnowledge({ ...state, links: state.links.filter(link => !same(link)) });
      return { changed: state.links.some(same) };
    }
    const proposition = nodes().find(entry => entry.id === graphNodeId);
    if (!proposition) throw new Error("This proposition is no longer available. Refresh before reviewing.");
    const fingerprint = matchFingerprint(node, proposition);
    if (v.fingerprint !== fingerprint) throw new Error("The unit or proposition changed. Refresh and inspect it again before confirming.");
    if (action === "reject") {
      store.saveKnowledge({ ...state, rejected: [...state.rejected.filter(entry => !same(entry)), { pathId, pathNodeId: nodeId, graphNodeId, fingerprint }] });
      return { changed: true };
    }
    const relationship = text(v.relationship, "relationship") as KnowledgeRelationship;
    if (!KNOWLEDGE_RELATIONSHIPS.includes(relationship)) throw new Error("Invalid knowledge relationship.");
    const origin = v.origin;
    if (origin !== "manual" && origin !== "suggested") throw new Error("Invalid origin.");
    const rationale = text(v.rationale, "rationale", 2000);
    const coverage = v.coverage ?? "unassessed";
    if (coverage !== "unassessed" && coverage !== "partial" && coverage !== "full") throw new Error("Invalid coverage.");
    if (relationship !== "covers" && coverage !== "unassessed") throw new Error("Coverage applies only to covers links.");
    const previous = state.links.find(same);
    store.saveKnowledge({ links: [...state.links.filter(link => !same(link)), { pathId, pathNodeId: nodeId, graphNodeId, relationship, coverage, origin, rationale, confirmedAt: previous?.confirmedAt ?? new Date().toISOString() }],
      rejected: state.rejected.filter(entry => !same(entry)) });
    return { changed: true };
  };
  return { inspect, discover, search, mutate, fingerprint: (input: unknown) => {
    const v = object(input), { node } = unit(v);
    const proposition = nodes().find(entry => entry.id === text(v.graphNodeId, "graphNodeId"));
    if (!proposition) throw new Error("Proposition is unavailable.");
    return { proposition, fingerprint: matchFingerprint(node, proposition) };
  } };
}
