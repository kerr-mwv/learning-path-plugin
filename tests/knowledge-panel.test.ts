/** The real inspector panel against host widgets and the real backend service. */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphNode } from "learnharness-plugin-api";
import type { LearningPath } from "../src/domain.ts";
import { createKnowledgePanel } from "../src/view/knowledge-panel.ts";
import { openDraftKnowledgeDialog } from "../src/view/draft-knowledge-dialog.ts";
import { makePath, AT } from "./fixtures.ts";
import { createHost } from "./host.ts";
import { createViewFixture, setSelect, fire } from "./view-host.ts";

const graphNode: GraphNode = { id: "n_prior", name: "Prior concept", statement: "Node n-concept connects to node n-skill through a prior explanation.", aliases: [], createdAt: AT,
  provenance: [{ chatId: "prior-session", messageId: "msg1" }] };

async function setup(t: { after(fn: () => void): void }) {
  const backend = createHost({ graphNodes: [graphNode] }); t.after(() => backend.close());
  await backend.call("architect.create"); await backend.runTool("save_learning_path", makePath());
  const path = (await backend.call<{ path: LearningPath }>("paths.get", { id: makePath().id })).path;
  const fixture = createViewFixture({ paths: [path] }); t.after(() => fixture.restore());
  fixture.context.call = (name, input) => backend.call(name, input);
  const node = path.modules[0]!.nodes[1]!;
  const dispose = createKnowledgePanel(fixture.context, fixture.root, fixture.context.signal, path, node); t.after(dispose);
  await fixture.flush();
  const click = async (label: string) => {
    const button = fixture.findLast("mountButton", record => record.props.label === label);
    button.props.onClick(); await fixture.flush();
  };
  return { backend, fixture, path, node, dispose, click };
}

test("inspector explicitly confirms partial coverage, inspects provenance and safely unlinks", async t => {
  const { fixture, backend, path, node, click } = await setup(t);
  assert.match(fixture.root.textContent ?? "", /No confirmed graph links/);
  await click("Check existing knowledge");
  assert.match(fixture.root.textContent ?? "", /prior-session.*msg1/);
  assert.match(fixture.root.textContent ?? "", /not proof of equivalent meaning/);
  assert.equal((await backend.call<{ links: unknown[] }>("knowledge.inspect", { pathId: path.id, nodeId: node.id })).links.length, 0);
  const selects = [...fixture.root.querySelectorAll("select")];
  setSelect(selects[0]!, "covers"); fire(selects[0]!, "change"); setSelect(selects[1]!, "partial");
  await click("Confirm link: Prior concept");
  await click("Show confirmed knowledge");
  assert.match(fixture.root.textContent ?? "", /covers · coverage partial · suggested/);
  await click("Unlink Prior concept");
  assert.equal((await backend.call<{ links: unknown[] }>("knowledge.inspect", { pathId: path.id, nodeId: node.id })).links.length, 0);
  assert.deepEqual((await backend.call<{ path: LearningPath }>("paths.get", { id: path.id })).path, path);
});

test("manual search and whole-path confirmation use the reviewed unit, never current selection by accident", async t => {
  const { fixture, backend, path, node, click } = await setup(t);
  (fixture.root.querySelector("input") as HTMLInputElement).value = "n_prior";
  await click("Search propositions"); await click("Confirm link: Prior concept");
  await click("Show confirmed knowledge"); assert.match(fixture.root.textContent ?? "", /related · coverage unassessed · manual/);
  await click("Check whole path");
  const other = [...fixture.root.querySelectorAll("section")].find(section => section.querySelector("h4")?.textContent === "Node n-skill");
  assert.ok(other);
  const confirm = fixture.all("mountButton").find(record => record.props.label === "Confirm link: Prior concept" && other!.contains(record.container));
  assert.ok(confirm); confirm.props.onClick(); await fixture.flush();
  assert.equal((await backend.call<{ links: unknown[] }>("knowledge.inspect", { pathId: path.id, nodeId: "n-skill" })).links.length, 1);
  assert.equal((await backend.call<{ links: unknown[] }>("knowledge.inspect", { pathId: path.id, nodeId: node.id })).links.length, 1);
});

test("rejected matches stay dismissed; stale confirmations show an actionable error", async t => {
  const { fixture, backend, path, node, click } = await setup(t);
  await click("Check existing knowledge"); await click("Reject match: Prior concept"); await click("Check existing knowledge");
  assert.match(fixture.root.textContent ?? "", /No new matching candidates/);
  (fixture.root.querySelector("input") as HTMLInputElement).value = "n_prior";
  await click("Search propositions");
  backend.ctx.learning.graph = () => ({ propositions: [] }) as never;
  await click("Confirm link: Prior concept");
  assert.match(fixture.root.textContent ?? "", /no longer available/);
  assert.equal((await backend.call<{ links: unknown[] }>("knowledge.inspect", { pathId: path.id, nodeId: node.id })).links.length, 0);
});

test("late responses after panel disposal cannot append results or mount widgets", async t => {
  const { fixture, dispose, click } = await setup(t);
  let resolve: ((value: unknown) => void) | undefined;
  fixture.context.call = <T>() => new Promise<T>(done => { resolve = value => done(value as T); });
  await click("Check existing knowledge");
  dispose(); const mounts = fixture.records.length; const before = fixture.root.textContent;
  resolve?.({ units: [{ nodeId: "n-concept", title: "Late", candidates: [] }], notice: "Late", truncated: false });
  await fixture.flush(); assert.equal(fixture.records.length, mounts); assert.equal(fixture.root.textContent, before);
});

test("draft dialog supports discovery without saving a path or making associations", async t => {
  const backend = createHost({ graphNodes: [graphNode] }); t.after(() => backend.close());
  const fixture = createViewFixture(); t.after(() => fixture.restore()); fixture.context.call = (name, input) => backend.call(name, input);
  openDraftKnowledgeDialog(fixture.context, fixture.context.signal); await fixture.flush();
  const dialog = fixture.find("openDialog").contentContainer!;
  (dialog.querySelector("input") as HTMLInputElement).value = "Node n-concept";
  (dialog.querySelector("textarea") as HTMLTextAreaElement).value = "Explain the connection to node n-skill";
  fixture.find("mountButton", record => record.props.label === "Check draft knowledge").props.onClick(); await fixture.flush();
  assert.match(dialog.textContent ?? "", /Prior concept/); assert.match(dialog.textContent ?? "", /prior-session/);
  assert.equal((await backend.call<{ paths: unknown[] }>("paths.list")).paths.length, 0);
});

test("Path Hub knowledge notifications preserve remaining review edits and whole-path scope", async t => {
  const { mountPathHub } = await import("../src/view/path-hub.ts");
  const graph = ["First", "Second", "Third"].map((name, index) => ({ ...graphNode, id: `n_${index}`, name }));
  const backend = createHost({ graphNodes: graph }); t.after(() => backend.close());
  await backend.call("architect.create"); await backend.runTool("save_learning_path", makePath());
  const saved = (await backend.call<{ path: LearningPath }>("paths.get", { id: makePath().id })).path;
  const fixture = createViewFixture({ paths: [saved] }); t.after(() => fixture.restore());
  const ordinaryCall = fixture.context.call;
  fixture.context.call = (name, input) => name.startsWith("knowledge.") ? backend.call(name, input) : ordinaryCall(name, input);
  const emit = backend.ctx.events.emit;
  backend.ctx.events.emit = (topic, data) => { emit(topic, data); fixture.emit(topic, data); };
  const dispose = mountPathHub(fixture.context, fixture.root, fixture.context.signal); t.after(dispose); await fixture.flush();
  fixture.find("mountButton", record => record.props.label === "Check whole path").props.onClick(); await fixture.flush();
  const unitSection = (title: string) => [...fixture.root.querySelectorAll(".lp-knowledge-results section")].find(section => section.querySelector("h4")?.textContent === title)!;
  const current = unitSection("Node n-holistic"), other = unitSection("Node n-skill");
  assert.ok(current); assert.ok(other);
  const secondCard = [...other.querySelectorAll("article")].find(card => card.querySelector("strong")?.textContent === "Second")!;
  const rationale = secondCard.querySelector("textarea")!; rationale.value = "Keep this prerequisite explanation while reviewing other matches.";
  const relation = secondCard.querySelector("select")!; setSelect(relation, "requires"); fire(relation, "change");
  const decide = async (section: Element, label: string) => {
    const button = fixture.all("mountButton").find(record => record.props.label === label && section.contains(record.container));
    assert.ok(button); button.props.onClick(); await fixture.flush();
  };
  await decide(current, "Confirm link: First");
  assert.ok(fixture.root.contains(secondCard), "knowledge-only event must not rebuild inspector");
  assert.equal(secondCard.querySelector("textarea"), rationale); assert.equal(rationale.value, "Keep this prerequisite explanation while reviewing other matches.");
  assert.equal([...relation.options].find(option => option.selected)?.value, "requires");
  await decide(current, "Reject match: Third");
  assert.ok(fixture.root.contains(secondCard), "reject also preserves the remaining review"); assert.equal(rationale.value, "Keep this prerequisite explanation while reviewing other matches.");
  await decide(other, "Confirm link: Second");
  const scope = { pathId: saved.id, nodeId: "n-skill" };
  const inspected = await backend.call<{ links: { link: { relationship: string; rationale: string } }[] }>("knowledge.inspect", scope);
  assert.equal(inspected.links.length, 1); assert.equal(inspected.links[0]!.link.relationship, "requires"); assert.equal(inspected.links[0]!.link.rationale, rationale.value);
  const original = await backend.call<{ links: unknown[] }>("knowledge.inspect", { pathId: saved.id, nodeId: "n-holistic" });
  assert.equal(original.links.length, 1, "other unit's confirmation does not attach to selected unit");
});

test("confirmed panels refetch knowledge-only changes from another view", async t => {
  const { fixture, backend, path, node } = await setup(t);
  const scope = { pathId: path.id, nodeId: node.id, graphNodeId: graphNode.id };
  const preview = await backend.call<{ fingerprint: string }>("knowledge.preview", scope);
  await backend.call("knowledge.link", { ...scope, fingerprint: preview.fingerprint, relationship: "related", origin: "manual", rationale: "Added in another view" });
  fixture.emit("paths-changed", { knowledgeChanged: true }); await fixture.flush();
  assert.match(fixture.root.textContent ?? "", /Added in another view/);
});
