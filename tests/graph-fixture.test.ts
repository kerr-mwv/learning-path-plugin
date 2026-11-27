/** The synthetic Velora fixture is valid graph-ledger data and a valid path. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateLearningPath } from "../src/domain.ts";

const fixture = new URL("../fixtures/velora/", import.meta.url);
const readLines = (name: string): Record<string, unknown>[] =>
  fs.readFileSync(new URL(name, fixture), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
const readJson = (name: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(new URL(name, fixture), "utf8")) as Record<string, unknown>;

const STOP_WORDS = new Set("a an and are as at be by can chapter course explain for from how in is it of on or section source that the their this to understand use using with".split(" "));
function words(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length > 2 && !STOP_WORDS.has(word)));
}

test("Velora graph fixture has unique nodes, resolving chains and one notes source", () => {
  const nodes = readLines("graph/nodes.jsonl");
  const chains = readLines("graph/chains.jsonl");
  const source = readJson("graph/sources.json") as Record<string, { id: string; filePath: string; importedAt: string }>;

  assert.equal(nodes.length, 9);
  assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length);
  assert.equal(chains.length, 5);

  const ids = new Set(nodes.map(node => node.id));
  for (const chain of chains) {
    assert.ok(ids.has(chain.conclusion as string), `chain ${chain.id} conclusion must exist`);
    assert.ok((chain.premises as string[]).length > 0);
    for (const premise of chain.premises as string[]) assert.ok(ids.has(premise), `chain ${chain.id} premise must exist`);
  }
  assert.equal(chains.filter(chain => (chain.premises as string[]).length > 1).length, 2, "the fixture should exercise implication nodes");

  const sourceId = "src_velora01";
  assert.ok(source[sourceId]);
  for (const record of [...nodes, ...chains]) {
    const provenance = record.provenance as { chatId: string; messageId: string }[];
    assert.ok(provenance.length > 0);
    for (const point of provenance) {
      assert.equal(point.chatId, sourceId);
      assert.equal(typeof point.messageId, "string");
    }
  }
});

test("Velora path fixture validates and every unit lexically matches the graph", () => {
  const record = readJson("path/path-velora-beads.json") as { schemaVersion: number; revision: number; path: unknown };
  assert.equal(record.schemaVersion, 1);
  assert.equal(typeof record.revision, "number");
  const validated = validateLearningPath(record.path);
  assert.ok(validated.ok, validated.ok ? "" : JSON.stringify(validated.issues));
  if (!validated.ok) return;

  const statements = readLines("graph/nodes.jsonl").map(node => [
    String(node.statement),
    ...(node.aliases as string[]),
  ].join(" "));
  const graphWords = statements.map(words);
  for (const module of validated.value.modules) {
    for (const node of module.nodes) {
      const query = words([node.title, node.goal, node.sourceAnchor.reference].join(" "));
      const match = graphWords.some(candidate => [...query].some(word => candidate.has(word)));
      assert.ok(match, `path unit ${node.id} should retrieve at least one fixture proposition`);
    }
  }
});
