/** Read-only graph retrieval and plugin-owned associations. No mastery model. */
import { createHash } from "node:crypto";
import type { GraphNode } from "learnharness-plugin-api";
import type { PathNode } from "./domain.ts";

export const KNOWLEDGE_RELATIONSHIPS = ["covers", "requires", "related"] as const;
export type KnowledgeRelationship = (typeof KNOWLEDGE_RELATIONSHIPS)[number];
export interface KnowledgeLink {
  readonly pathId: string;
  readonly pathNodeId: string;
  readonly graphNodeId: string;
  readonly relationship: KnowledgeRelationship;
  readonly rationale: string;
  /** Learner assessment of unit coverage, never a mastery claim. */
  readonly coverage: "unassessed" | "partial" | "full";
  readonly origin: "manual" | "suggested";
  readonly confirmedAt: string;
}
export interface RejectedKnowledgeMatch {
  readonly pathId: string;
  readonly pathNodeId: string;
  readonly graphNodeId: string;
  readonly fingerprint: string;
}
export interface KnowledgeState {
  readonly links: readonly KnowledgeLink[];
  readonly rejected: readonly RejectedKnowledgeMatch[];
}
export interface KnowledgeQuery {
  readonly title: string;
  readonly goal: string;
  readonly sourceAnchor?: { readonly reference: string; readonly chapter?: string; readonly section?: string };
}
export interface KnowledgeCandidate {
  readonly proposition: GraphNode;
  readonly fingerprint: string;
  /** Retrieval is not equivalence assessment: all lexical matches start related. */
  readonly relationship: "related";
  readonly coverage: "unassessed";
  readonly rationale: string;
}
export interface KnowledgeDiscovery {
  readonly units: readonly { readonly nodeId: string; readonly title: string; readonly candidates: readonly KnowledgeCandidate[] }[];
  readonly notice: string;
  readonly truncated: boolean;
}
export interface KnowledgeInspection {
  readonly links: readonly { readonly link: KnowledgeLink; readonly proposition: GraphNode | null }[];
  readonly available: boolean;
  readonly notice: string;
}
export const MAX_GRAPH_SCAN = 10_000;
export const MAX_KNOWLEDGE_CANDIDATES = 10;
export const MAX_DISCOVERY_UNITS = 100;
export const RETRIEVAL_NOTICE = "Local word/alias matching only: relevance and coverage are unassessed. Inspect the precise statement; graph presence is not evidence of mastery. No model call or transcript retrieval is performed.";

export function matchFingerprint(query: KnowledgeQuery, proposition: GraphNode): string {
  return createHash("sha256").update(JSON.stringify([query.title, query.goal, query.sourceAnchor ?? null,
    proposition.id, proposition.statement, [...proposition.aliases].sort()])).digest("hex");
}

const STOP_WORDS = new Set("a an and are as at be by can chapter course explain for from how in is it of on or section source that the their this to understand use using with".split(" "));
function words(text: string): Set<string> {
  return new Set((text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(word => word.length > 2 && !STOP_WORDS.has(word)));
}

/** A bounded lexical retriever, deliberately not a semantic-equivalence classifier.
 * Statements and recorded aliases outweigh ambiguous short display names. */
export function discoverKnowledge(
  query: KnowledgeQuery,
  nodes: readonly GraphNode[],
  excluded: ReadonlySet<string> = new Set(),
): KnowledgeCandidate[] {
  const terms = words(`${query.title} ${query.goal} ${query.sourceAnchor?.chapter ?? ""} ${query.sourceAnchor?.section ?? ""}`);
  const seen = new Set<string>();
  const ranked: { score: number; candidate: KnowledgeCandidate }[] = [];
  for (const proposition of nodes.slice(0, MAX_GRAPH_SCAN)) {
    if (seen.has(proposition.id)) continue;
    seen.add(proposition.id);
    if (excluded.has(proposition.id)) continue;
    const statement = words(`${proposition.statement} ${proposition.aliases.join(" ")}`);
    const name = words(proposition.name);
    const strong = [...terms].filter(term => statement.has(term));
    const weak = [...terms].filter(term => !statement.has(term) && name.has(term));
    const score = strong.length * 3 + weak.length;
    if (!score) continue;
    ranked.push({ score, candidate: {
      proposition, fingerprint: matchFingerprint(query, proposition), relationship: "related", coverage: "unassessed",
      rationale: `Shared terms: ${[...strong, ...weak].slice(0, 12).join(", ")}. This is a retrieval hint, not proof of equivalent meaning or full unit coverage.`,
    } });
  }
  return ranked.sort((a, b) => b.score - a.score || a.candidate.proposition.id.localeCompare(b.candidate.proposition.id))
    .slice(0, MAX_KNOWLEDGE_CANDIDATES).map(entry => entry.candidate);
}

export function discoverUnit(node: PathNode, pathId: string, nodes: readonly GraphNode[], state: KnowledgeState): KnowledgeCandidate[] {
  const excluded = new Set(state.links.filter(link => link.pathId === pathId && link.pathNodeId === node.id).map(link => link.graphNodeId));
  for (const rejection of state.rejected) {
    if (rejection.pathId !== pathId || rejection.pathNodeId !== node.id) continue;
    const proposition = nodes.find(entry => entry.id === rejection.graphNodeId);
    if (proposition && matchFingerprint(node, proposition) === rejection.fingerprint) excluded.add(proposition.id);
  }
  return discoverKnowledge(node, nodes, excluded);
}

/** Strict validation protects the independent sidecar before any store writes. */
export function parseKnowledgeState(value: unknown): KnowledgeState {
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Knowledge data must be an object.");
    return v as Record<string, unknown>;
  };
  const text = (v: unknown, max = 128): string => {
    if (typeof v !== "string" || !v.trim() || v !== v.trim() || v.length > max) throw new Error("Invalid knowledge-link text.");
    return v;
  };
  const record = object(value);
  if (!Array.isArray(record.links) || !Array.isArray(record.rejected)) throw new Error("Knowledge links and rejections must be arrays.");
  const seen = new Set<string>();
  const identity = (v: Record<string, unknown>) => ({ pathId: text(v.pathId), pathNodeId: text(v.pathNodeId), graphNodeId: text(v.graphNodeId) });
  const links = record.links.map(value => {
    const v = object(value), ids = identity(v);
    const relationship = text(v.relationship) as KnowledgeRelationship;
    if (!KNOWLEDGE_RELATIONSHIPS.includes(relationship)) throw new Error("Invalid knowledge relationship.");
    const origin = text(v.origin);
    if (origin !== "manual" && origin !== "suggested") throw new Error("Invalid knowledge-link origin.");
    const confirmedAt = text(v.confirmedAt, 32);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(confirmedAt) || !Number.isFinite(Date.parse(confirmedAt))) throw new Error("Invalid confirmation timestamp.");
    const key = JSON.stringify([ids.pathId, ids.pathNodeId, ids.graphNodeId]);
    if (seen.has(key)) throw new Error("Duplicate knowledge association.");
    seen.add(key);
    const coverage = v.coverage ?? "unassessed";
    if (coverage !== "unassessed" && coverage !== "partial" && coverage !== "full") throw new Error("Invalid knowledge coverage.");
    return { ...ids, relationship, coverage, origin, confirmedAt, rationale: text(v.rationale, 2000) } satisfies KnowledgeLink;
  });
  const rejectedSeen = new Set<string>();
  const rejected = record.rejected.map(value => {
    const v = object(value), ids = identity(v), fingerprint = text(v.fingerprint, 64);
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid knowledge fingerprint.");
    const key = JSON.stringify([ids.pathId, ids.pathNodeId, ids.graphNodeId]);
    if (rejectedSeen.has(key)) throw new Error("Duplicate rejected association.");
    rejectedSeen.add(key);
    return { ...ids, fingerprint };
  });
  return { links, rejected };
}
