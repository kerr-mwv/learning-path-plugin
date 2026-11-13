/** Retrieval, persistence and public backend boundary for knowledge integration. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GraphNode } from "learnharness-plugin-api";
import { discoverKnowledge, matchFingerprint, MAX_GRAPH_SCAN, parseKnowledgeState } from "../src/knowledge.ts";
import type { KnowledgeDiscovery, KnowledgeInspection, KnowledgeState } from "../src/knowledge.ts";
import { KNOWLEDGE_FILE, LEARNING_PATHS_FILE, openLearningPathStore } from "../src/store.ts";
import type { LearningPath } from "../src/domain.ts";
import { AT, makePath } from "./fixtures.ts";
import { createHost } from "./host.ts";

export function proposition(id = "n_probability", overrides: Partial<GraphNode> = {}): GraphNode {
  return { id, name: "Conditional probability", statement: "Conditional probability restricts the sample space to the conditioning event.",
    aliases: ["Probability given an event"], createdAt: AT, provenance: [{ chatId: "prior-chat", messageId: "message-2" }], ...overrides };
}
const draft = { title: "Conditional probability", goal: "Derive probability given an event and interpret the sample space." };

test("retrieval ranks statements and aliases, deduplicates IDs and never assesses equivalence", () => {
  const graph = [proposition("exact"), proposition("paraphrase", { name: "Restricted universe", statement: "The measure is renormalised on a restricted universe.", aliases: ["Conditional probability"] }),
    proposition("homonym", { name: "Conditional probability", statement: "This is an unrelated chapter label.", aliases: [] }), proposition("exact")];
  const matches = discoverKnowledge(draft, graph);
  assert.equal(matches.length, 3);
  assert.equal(matches[0]!.proposition.id, "exact");
  assert.ok(matches.find(match => match.proposition.id === "paraphrase"), "recorded paraphrases/aliases can retrieve the proposition");
  assert.equal(matches.at(-1)!.proposition.id, "homonym", "display-name-only matches are weaker, never automatic links");
  for (const match of matches) {
    assert.equal(match.relationship, "related"); assert.equal(match.coverage, "unassessed");
    assert.match(match.rationale, /not proof.*full unit coverage/);
  }
  assert.deepEqual(discoverKnowledge(draft, [], new Set()), []);
  assert.deepEqual(discoverKnowledge(draft, [proposition()], new Set(["n_probability"])), []);
  assert.equal(discoverKnowledge(draft, Array.from({ length: 30 }, (_, i) => proposition(`id${i}`))).length, 10);
  const noMatch = proposition("other", { name: "Arithmetic", statement: "Two plus two equals four.", aliases: [] });
  assert.deepEqual(discoverKnowledge(draft, [...Array(MAX_GRAPH_SCAN).fill(noMatch), proposition()]), [], "scan cap is enforced");
});

test("sidecar defaults preserve old path bytes; validated links survive restart and safe path deletion", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-knowledge-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let store = openLearningPathStore(dir);
  store.savePath(makePath()); store.savePath({ ...makePath(), id: "path-2" });
  const before = fs.readFileSync(path.join(dir, LEARNING_PATHS_FILE), "utf8");
  store = openLearningPathStore(dir);
  assert.deepEqual(store.knowledge(), { links: [], rejected: [] });
  const link = { pathId: makePath().id, pathNodeId: "n-concept", graphNodeId: "n_probability", relationship: "covers" as const, coverage: "partial" as const, origin: "manual" as const, rationale: "One part of this unit", confirmedAt: AT };
  store.saveKnowledge({ links: [link, { ...link, pathId: "path-2" }, { ...link, pathNodeId: "n-skill" }], rejected: [] });
  assert.equal(fs.readFileSync(path.join(dir, LEARNING_PATHS_FILE), "utf8"), before, "linking never rewrites learner state");
  store = openLearningPathStore(dir);
  assert.equal(store.knowledge().links.length, 3);
  assert.deepEqual(store.path(makePath().id), makePath());
  const copy = store.knowledge(); (copy.links as unknown[]).length = 0;
  assert.equal(store.knowledge().links.length, 3, "callers cannot mutate persisted state by reference");
  assert.throws(() => store.saveKnowledge({ links: [link, link], rejected: [] }), /Duplicate/);
  store.deletePath(makePath().id);
  assert.deepEqual(store.knowledge().links.map(link => link.pathId), ["path-2"]);
  assert.equal(store.path("path-2")!.modules[0]!.nodes[1]!.childSessions.length, 1);
  const newer = JSON.stringify({ schemaVersion: 2, revision: 0, knowledge: { links: [], rejected: [] } });
  fs.writeFileSync(path.join(dir, KNOWLEDGE_FILE), newer);
  assert.throws(() => openLearningPathStore(dir), /newer schema/);
  assert.equal(fs.readFileSync(path.join(dir, KNOWLEDGE_FILE), "utf8"), newer);
});

test("invalid sidecars are refused without changing records", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-knowledge-invalid-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filename = path.join(dir, KNOWLEDGE_FILE);
  for (const knowledge of [{ links: "bad", rejected: [] }, { links: [{ pathId: "p" }], rejected: [] }]) {
    const bytes = JSON.stringify({ schemaVersion: 1, revision: 0, knowledge }); fs.writeFileSync(filename, bytes);
    assert.throws(() => openLearningPathStore(dir), /Invalid knowledge links/);
    assert.equal(fs.readFileSync(filename, "utf8"), bytes);
  }
  assert.throws(() => parseKnowledgeState({ links: [], rejected: [{ pathId: "p", pathNodeId: "u", graphNodeId: "g", fingerprint: "wrong" }] }), /fingerprint/);
});

test("backend proposals require explicit fresh confirmation; rejects persist until meaning changes", async t => {
  const graph = [proposition()];
  const host = createHost({ graphNodes: graph }); t.after(() => host.close());
  const store = openLearningPathStore(host.dataDirectory); const original = makePath();
  const p: LearningPath = { ...original, modules: original.modules.map((module, index) => index === 0
    ? { ...module, nodes: module.nodes.map(node => node.id === "n-concept" ? { ...node, ...draft } : node) } : module) };
  // Save through the Architect so the active backend owns the same in-memory records.
  await host.call("architect.create"); await host.runTool("save_learning_path", p);
  const before = (await host.call<{ path: LearningPath }>("paths.get", { id: p.id })).path;
  const scope = { pathId: p.id, nodeId: "n-concept" };
  const result = await host.call<KnowledgeDiscovery>("knowledge.discover", scope);
  const match = result.units[0]!.candidates[0]!;
  assert.equal(match.proposition.id, graph[0]!.id);
  assert.equal((await host.call<KnowledgeInspection>("knowledge.inspect", scope)).links.length, 0);
  await host.call("knowledge.reject", { ...scope, graphNodeId: match.proposition.id, fingerprint: match.fingerprint });
  assert.equal((await host.call<KnowledgeDiscovery>("knowledge.discover", scope)).units[0]!.candidates.length, 0);
  assert.equal(openLearningPathStore(host.dataDirectory).knowledge().rejected.length, 1);
  graph[0] = { ...graph[0]!, statement: `${graph[0]!.statement} New, materially different statement.` };
  await assert.rejects(host.call("knowledge.link", { ...scope, graphNodeId: match.proposition.id, fingerprint: match.fingerprint, relationship: "covers", origin: "suggested", rationale: "Partial coverage" }), /changed/);
  const fresh = (await host.call<KnowledgeDiscovery>("knowledge.discover", scope)).units[0]!.candidates[0]!;
  assert.notEqual(fresh.fingerprint, match.fingerprint);
  const confirm = { ...scope, graphNodeId: fresh.proposition.id, fingerprint: fresh.fingerprint, relationship: "covers", coverage: "partial", origin: "suggested", rationale: "Only the conditional-probability component" };
  await host.call("knowledge.link", confirm); await host.call("knowledge.link", confirm);
  assert.equal((await host.call<KnowledgeInspection>("knowledge.inspect", scope)).links.length, 1);
  assert.equal((await host.call<KnowledgeDiscovery>("knowledge.discover", scope)).units[0]!.candidates.length, 0);
  assert.deepEqual((await host.call<{ path: unknown }>("paths.get", { id: p.id })).path, before, "progress, errors, chats and pivots remain unchanged");
  graph.length = 0;
  const missing = await host.call<KnowledgeInspection>("knowledge.inspect", scope);
  assert.equal(missing.links[0]!.proposition, null); assert.equal(missing.available, true);
  await host.call("knowledge.unlink", { ...scope, graphNodeId: fresh.proposition.id });
  assert.equal((await host.call<KnowledgeInspection>("knowledge.inspect", scope)).links.length, 0);
  assert.deepEqual(store.knowledge(), { links: [], rejected: [] }, "an independently opened store does not acquire in-memory mutations");
});

test("Architect supports draft discovery and confirmed link discussion without write tools", async t => {
  const host = createHost({ graphNodes: [proposition()] }); t.after(() => host.close()); await host.call("architect.create");
  const result = await host.runTool<{ details: KnowledgeDiscovery }>("check_existing_knowledge", { draft });
  assert.equal(result.details.units[0]!.candidates.length, 1);
  assert.match(result.details.notice, /not evidence of mastery/);
  assert.ok(![...host.definitions.values()][0]!.tools!.some(tool => tool.name === "knowledge.link"));
  assert.equal(fs.existsSync(path.join(host.dataDirectory, KNOWLEDGE_FILE)), false);
  const learning = host.ctx.learning;
  const read = learning.graph;
  learning.graph = () => { throw new Error("Graph service offline"); };
  const unavailable = await host.call<KnowledgeDiscovery>("knowledge.discover", { draft });
  assert.match(unavailable.notice, /unavailable/); assert.deepEqual(unavailable.units, []);
  learning.graph = read;
  const huge = await host.call<KnowledgeDiscovery>("knowledge.discover", { draft }); assert.equal(huge.truncated, false);
  assert.equal(matchFingerprint(draft, proposition()), result.details.units[0]!.candidates[0]!.fingerprint);
});

test("uses merged proposition projection, never raw link-appends or derived canvas nodes", async t => {
  const host = createHost({ graphNodes: [proposition()] }); t.after(() => host.close());
  host.ctx.learning.readGraphFile = () => { throw new Error("Raw ledgers must not be read for matching"); };
  const original = host.ctx.learning.graph;
  host.ctx.learning.graph = () => ({ ...original(), nodes: [proposition("derived-implication")], propositions: [proposition("merged", { aliases: ["Conditional probability", "Posterior reasoning"] })] });
  const found = await host.call<KnowledgeDiscovery>("knowledge.discover", { draft });
  assert.deepEqual(found.units[0]!.candidates.map(match => match.proposition.id), ["merged"]);
  assert.ok(found.units[0]!.candidates[0]!.proposition.aliases.includes("Posterior reasoning"));
});

test("retry cleans sidecar after an interrupted path deletion without touching native data", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-knowledge-retry-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = openLearningPathStore(dir); store.savePath(makePath());
  store.saveKnowledge({ links: [{ pathId: makePath().id, pathNodeId: "n-concept", graphNodeId: "native", relationship: "related", coverage: "unassessed", origin: "manual", rationale: "Relevant context", confirmedAt: AT }], rejected: [] });
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (String(destination).endsWith(KNOWLEDGE_FILE)) throw new Error("Synthetic sidecar failure");
    return rename(source, destination);
  });
  assert.throws(() => store.deletePath(makePath().id), /Synthetic sidecar failure/);
  assert.equal(store.path(makePath().id), null); assert.equal(store.knowledge().links.length, 1);
  mock.mock.restore();
  assert.equal(store.deletePath(makePath().id), false);
  assert.deepEqual(openLearningPathStore(dir).knowledge(), { links: [], rejected: [] });
});
