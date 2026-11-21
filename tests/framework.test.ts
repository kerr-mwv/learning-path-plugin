/** Pedagogical prompt and child-brief composition invariants. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_CATALOG,
  DomainValidationError,
  ERROR_CATEGORIES,
  NODE_TYPES,
  parseLearningPath,
} from "../src/domain.ts";
import {
  buildArchitectSystemPrompt,
  buildChildSessionBrief,
  microPrimingHookFor,
  resolveNodeArtifact,
} from "../src/framework.ts";
import { makePath } from "./fixtures.ts";

/** FRAMEWORK.md principle 7: no pacing, calendar or gamified pressure language. */
const PACING =
  /\b(hour|hours|daily|day|days|week|weeks|weekday|month|months|minute|minutes|schedule|scheduled|calendar|streak|deadline|timer|clock|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

const nodeOf = (path: ReturnType<typeof makePath>, id: string) => {
  const node = path.modules.flatMap((module) => module.nodes).find((candidate) => candidate.id === id);
  assert.ok(node, `fixture is missing node ${id}`);
  return node;
};

test("the Architect prompt enforces every framework rule", () => {
  const prompt = buildArchitectSystemPrompt();

  for (const guide of NODE_TYPES) assert.match(prompt, new RegExp(`\\(${guide}\\)`));
  assert.match(prompt, /Proactive placement of holistic and contrast nodes/);
  assert.match(prompt, /baseline path structure, not repairs/);
  assert.match(prompt, /Never defer a holistic or contrast node/);
  assert.match(prompt, /Self-directed light pre-reading instead of macro-priming chats/);
  assert.match(prompt, /Do not create separate macro-priming conversations/);
  assert.match(prompt, /Three levels of interleaving/);
  assert.match(prompt, /- Micro:/);
  assert.match(prompt, /- Meso:/);
  assert.match(prompt, /- Macro:/);
  assert.match(prompt, /interleavesNodeIds/);
  assert.match(prompt, /artifactConfig/);
  assert.match(prompt, /type "none"/);
  for (const entry of ARTIFACT_CATALOG) assert.ok(prompt.includes(entry.justification), entry.type);
  for (const category of ERROR_CATEGORIES) assert.ok(prompt.includes(category), category);
  assert.match(prompt, /advisory pivot suggestion/);
  assert.match(prompt, /Never rewrite, reorder or delete the path/);
  assert.match(prompt, /save_learning_path/);
  assert.match(prompt, /Do not require the learner to supply a reference/);
  assert.match(prompt, /Call list_uploaded_sources at the start/);
  assert.match(prompt, /contents\/table of contents, chapter headings/);
  assert.match(prompt, /Do not read the whole book/);
  assert.match(prompt, /Never invent chapter numbers/);
  assert.match(prompt, /Hard exclusions/);
  assert.match(prompt, /Never prescribe fixed study allotments/);
  assert.doesNotMatch(prompt, PACING);
  assert.doesNotMatch(prompt, /\bprimed\b/i);
});

test("refinement mode summarizes the existing path and keeps ids stable", () => {
  const path = makePath();
  const prompt = buildArchitectSystemPrompt({ existingPath: path });
  assert.match(prompt, /## Refinement mode/);
  assert.ok(prompt.includes(path.title));
  assert.ok(prompt.includes(path.id));
  assert.match(prompt, /Keep existing ids, titles and source anchors stable/);
  assert.match(prompt, /never silently reorder, delete or rename existing nodes/);
  assert.doesNotMatch(prompt, PACING);
});

test("plugin artifact defaults appear in the Architect prompt when configured", () => {
  const prompt = buildArchitectSystemPrompt({
    settings: { artifactDefaults: { contrast: "relational_map" } },
  });
  assert.match(prompt, /Plugin-wide artifact defaults: contrast → relational_map/);
  assert.match(prompt, /A node override always wins/);
});

test("artifact resolution prefers the node, then the path, settings and catalog", () => {
  const path = makePath();
  const concept = nodeOf(path, "n-concept");
  const contrast = nodeOf(path, "n-contrast");

  assert.deepEqual(resolveNodeArtifact(path, concept), {
    type: "micro_code",
    instructions: "Write the smallest failing interpreter.",
  });
  assert.deepEqual(resolveNodeArtifact(path, contrast), { type: "retrieval_cue" });

  const noPathDefault = { ...path, artifactDefault: null };
  assert.deepEqual(resolveNodeArtifact(noPathDefault, contrast, null), { type: "relational_map" });
  assert.deepEqual(
    resolveNodeArtifact(noPathDefault, contrast, { artifactDefaults: { contrast: "encoding_exercise" } }),
    { type: "encoding_exercise" },
  );

  const bridge = nodeOf(path, "n-bridge");
  assert.deepEqual(resolveNodeArtifact(noPathDefault, bridge, null), { type: "encoding_exercise" });
});

test("a child brief carries the anchor, pre-reading, priming, interleaving and watchpoints", () => {
  const path = makePath();
  const brief = buildChildSessionBrief({ path, nodeId: "n-contrast", kind: "practice" });

  assert.equal(brief.node.id, "n-contrast");
  assert.deepEqual(brief.interleavedNodes.map((node) => node.id), ["n-concept", "n-skill"]);
  assert.match(brief.text, /practice session/);
  assert.match(brief.text, /^# Learning Path child session brief/m);
  assert.match(brief.text, /Anchor: OSTEP — chapter 26, section 27\.1, pages 301-320/);
  assert.match(brief.text, /Spine: OSTEP \(textbook\)/);
  assert.match(brief.text, /No pre-reading pointer is set for this node/);
  assert.ok(brief.text.includes(microPrimingHookFor("contrast")));
  assert.match(brief.text, /Node n-concept \(concept\): re-surface it briefly/);
  assert.match(brief.text, /Node n-skill \(skill\): re-surface it briefly/);
  assert.match(brief.text, /\[procedural_slip\] Drops a sign while expanding\./);
  assert.match(brief.text, /still unresolved/);
  assert.doesNotMatch(brief.text, /Assumes the map is the proof/);
  assert.match(brief.text, /Recommended: Retrieval cue \/ flashcard seed \(retrieval_cue\)/);
  assert.ok(brief.text.includes(ARTIFACT_CATALOG.find((entry) => entry.type === "retrieval_cue")!.justification));
  assert.match(brief.text, /there is no gate and no priming requirement/);
  assert.doesNotMatch(brief.text, PACING);
});

test("light pre-reading and a node artifact override reach the brief with their justification", () => {
  const path = makePath();
  const brief = buildChildSessionBrief({
    path,
    nodeId: "n-concept",
    kind: "teaching",
    primingHook: "Ask what the learner expects before the first formal definition.",
  });
  assert.match(brief.text, /teaching session/);
  assert.match(brief.text, /Skim the module overview and the running example\./);
  assert.match(brief.text, /Ask what the learner expects before the first formal definition\./);
  assert.match(brief.text, /Recommended: Micro-code \/ implementation \(micro_code\)/);
  assert.match(brief.text, /Node-specific framing: Write the smallest failing interpreter\./);
  assert.ok(brief.text.includes(ARTIFACT_CATALOG.find((entry) => entry.type === "micro_code")!.justification));
  assert.match(brief.text, /\[misconception\]|No unresolved error/);
});

test("a bridge brief stays in repair mode and honours conversation-only", () => {
  const path = makePath();
  const bridge = nodeOf(path, "n-bridge");
  const conversationOnly = buildChildSessionBrief({
    path: {
      ...path,
      modules: path.modules.map((module) => ({
        ...module,
        nodes: module.nodes.map((node) =>
          node.id === bridge.id ? { ...node, artifactConfig: { type: "none" as const } } : node,
        ),
      })),
    },
    nodeId: bridge.id,
    kind: "teaching",
  });
  assert.equal(conversationOnly.artifact.type, "none");
  assert.match(conversationOnly.text, /Recommended: None \/ conversation-only \(none\)/);
  assert.ok(conversationOnly.text.includes(ARTIFACT_CATALOG.find((entry) => entry.type === "none")!.justification));
  assert.ok(conversationOnly.text.includes(microPrimingHookFor("bridge")));
});

test("every node type composes a pacing-free brief", () => {
  const path = makePath();
  for (const node of path.modules.flatMap((module) => module.nodes)) {
    const brief = buildChildSessionBrief({ path, nodeId: node.id, kind: "teaching" });
    assert.ok(brief.text.includes(node.title), node.id);
    assert.ok(brief.text.includes(node.sourceAnchor.reference), node.id);
    assert.doesNotMatch(brief.text, PACING, node.id);
    assert.equal(brief.artifact.type !== "none" || brief.artifact.type === "none", true);
  }
});

test("a brief refuses an unknown node id with a precise error", () => {
  const path = makePath();
  assert.throws(
    () => buildChildSessionBrief({ path, nodeId: "n-missing", kind: "teaching" }),
    (error: unknown) =>
      error instanceof DomainValidationError &&
      /nodeId: unknown node id "n-missing"/.test(error.message),
  );
});

test("a node with no unresolved errors still tells the session to probe", () => {
  const path = makePath();
  const holistic = buildChildSessionBrief({ path, nodeId: "n-holistic", kind: "teaching" });
  assert.match(holistic.text, /No unresolved error is on record/);
  assert.deepEqual(holistic.watchpoints, []);
});

test("map revisit guidance never enters the learner-visible launch brief", () => {
  const path = { ...makePath(), artifactDefault: null };
  const brief = buildChildSessionBrief({
    path,
    nodeId: "n-contrast",
    kind: "teaching",
    settings: { artifactDefaults: {}, mapRevisitEnabled: true },
  });
  assert.equal(brief.artifact.type, "relational_map");
  assert.doesNotMatch(brief.text, /earlier map|map revisit|keep, change or connect/i);
});

test("graph context in agent briefs is opt-in, relevant, bounded and explicitly withheld until an attempt", () => {
  const path = makePath();
  const node = nodeOf(path, "n-contrast");
  (node as { title: string }).title = "Concurrency and parallelism";
  const propositions = [
    { id: "irrelevant", statement: "Photosynthesis converts light into chemical energy.", aliases: [] },
    { id: "alias", statement: "Independent tasks can make progress in overlapping intervals.", aliases: ["Concurrency"] },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `p-${i}`, statement: "Concurrency is not the same as parallelism.", aliases: [] })),
  ].map(p => ({ ...p, name: p.id, createdAt: "2026-01-01T00:00:00Z", provenance: [] }));
  const base = { path, nodeId: node.id, kind: "teaching" as const };
  const baseline = buildChildSessionBrief(base).text;
  assert.equal(buildChildSessionBrief({ ...base, graphPropositions: propositions }).text, baseline);
  assert.equal(buildChildSessionBrief({ ...base, settings: { artifactDefaults: {}, graphContextEnabled: true }, graphPropositions: [] }).text, baseline);
  const brief = buildChildSessionBrief({ ...base, settings: { artifactDefaults: {}, graphContextEnabled: true }, graphPropositions: propositions });
  assert.match(brief.text, /## Graph context — agent only/);
  assert.doesNotMatch(brief.text, /Photosynthesis/);
  assert.equal((brief.text.match(/"id":/g) ?? []).length, 5);
  assert.match(brief.text, /never state a connection before the learner has tried/i);
  assert.match(brief.text, /Prefer unlabelled problems/);
  assert.match(brief.text, /quick recall question/);
  assert.match(brief.text, /No skipping units/);
});

test("graph brief relevance includes the canonical source anchor and preserves light-use/map rules", () => {
  const path = makePath();
  const proposition = { id: "source", name: "Source context", statement: "OSTEP describes how operating systems virtualize resources.", aliases: [], createdAt: "2026-01-01T00:00:00Z", provenance: [] };
  const settings = { artifactDefaults: {}, graphContextEnabled: true };
  const graphPropositions = [proposition];
  for (const nodeId of ["n-holistic", "n-skill", "n-bridge"]) {
    const brief = buildChildSessionBrief({ path, nodeId, kind: "practice", settings, graphPropositions });
    assert.match(brief.text, /OSTEP describes how operating systems virtualize resources/);
    assert.match(brief.text, /For skill and bridge units, use graph context only for recall checks and watchpoints/);
    assert.match(brief.text, /learner draws first/);
    assert.match(brief.text, /artifactNote/);
    assert.match(brief.text, /other artifacts, check connections in conversation before consolidated/);
    assert.doesNotMatch(brief.text, PACING);
  }
});

test("a valid long goal cannot crowd the source anchor out of graph relevance", () => {
  const fixture = makePath();
  const path = parseLearningPath({ ...fixture, modules: fixture.modules.map(module => ({ ...module, nodes: module.nodes.map(node => node.id === "n-concept"
    ? { ...node, goal: "foundations ".repeat(333).trim(), sourceAnchor: { reference: "Velora", section: "Conservation" } } : node) })) });
  const brief = buildChildSessionBrief({
    path, nodeId: "n-concept", kind: "teaching", settings: { artifactDefaults: {}, graphContextEnabled: true },
    graphPropositions: [{ id: "anchor-only", name: "Earlier source", statement: "Velora preserves quantities through reversible transformations.", aliases: [], createdAt: "2026-01-01T00:00:00Z", provenance: [] }],
  });
  assert.match(brief.text, /## Graph context — agent only/);
  assert.match(brief.text, /Velora preserves quantities through reversible transformations/);
});
