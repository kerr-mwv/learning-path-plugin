/** Domain schema and runtime validation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_CATALOG,
  ARTIFACT_TYPES,
  ERROR_CATEGORIES,
  NODE_TYPES,
  PIVOT_PROPOSAL_TYPES,
  PROGRESSION_STATES,
  artifactCatalogEntry,
  defaultArtifactFor,
  formatSourceAnchor,
  parseLearningPath,
  parsePluginSettings,
  recommendedArtifactsFor,
  validateLearningPath,
  validatePluginSettings,
} from "../src/domain.ts";
import type { LearningPath } from "../src/domain.ts";
import { AT, makePath, rawPath } from "./fixtures.ts";

test("accepts a full path covering all six node types and three progression states", () => {
  const path = makePath();
  const validated = parseLearningPath(path);
  assert.deepEqual(validated, path);
  const types = validated.modules.flatMap((module) => module.nodes.map((node) => node.type));
  assert.deepEqual([...types].sort(), [...NODE_TYPES].sort());
  assert.deepEqual(
    [...new Set(validated.modules.flatMap((module) => module.nodes.map((node) => node.progression)))].sort(),
    [...PROGRESSION_STATES].sort(),
  );
  assert.deepEqual(PROGRESSION_STATES, ["unstarted", "in_progress", "consolidated"]);
});

test("rejects an unknown node type and the removed priming gate", () => {
  for (const type of ["lecture", "primed"]) {
    const value = rawPath();
    value.modules[0].nodes[0].type = type;
    assert.throws(() => parseLearningPath(value), /type: must be one of: holistic, concept, contrast, skill, checkpoint, bridge/);
  }
});

test("rejects a progression state outside the three ungated states", () => {
  for (const progression of ["primed", "done", "reviewed"]) {
    const value = rawPath();
    value.modules[0].nodes[1].progression = progression;
    assert.throws(
      () => parseLearningPath(value),
      /progression: must be one of: unstarted, in_progress, consolidated/,
    );
  }
});

test("validates child session links, error entries and pivot suggestions", () => {
  const badKind = rawPath();
  badKind.modules[0].nodes[1].childSessions[0].kind = "seminar";
  assert.throws(() => parseLearningPath(badKind), /childSessions\[0\]\.kind/);

  const badCategory = rawPath();
  badCategory.modules[0].nodes[2].errors[0].category = "grade";
  assert.throws(() => parseLearningPath(badCategory), /errors\[0\]\.category: must be one of/);

  const resolvedWithoutStamp = rawPath();
  resolvedWithoutStamp.modules[0].nodes[2].errors[0].resolved = true;
  delete resolvedWithoutStamp.modules[0].nodes[2].errors[0].resolvedAt;
  assert.throws(() => parseLearningPath(resolvedWithoutStamp), /resolved error needs resolvedAt/);

  const unresolvedWithStamp = rawPath();
  unresolvedWithStamp.modules[0].nodes[2].errors[0].resolvedAt = AT;
  assert.throws(() => parseLearningPath(unresolvedWithStamp), /must not carry resolvedAt/);

  const badStatus = rawPath();
  badStatus.modules[0].nodes[2].pivotSuggestions[0].status = "maybe";
  assert.throws(() => parseLearningPath(badStatus), /status: must be one of/);

  const pendingWithStamp = rawPath();
  pendingWithStamp.modules[0].nodes[2].pivotSuggestions[0].resolvedAt = AT;
  assert.throws(() => parseLearningPath(pendingWithStamp), /pending pivot must not carry resolvedAt/);

  const dismissedWithoutStamp = rawPath();
  delete dismissedWithoutStamp.modules[1].nodes[2].pivotSuggestions[0].resolvedAt;
  assert.throws(() => parseLearningPath(dismissedWithoutStamp), /dismissed pivot needs resolvedAt/);

  const unknownInsertedNode = rawPath();
  unknownInsertedNode.modules[0].nodes[2].pivotSuggestions[0].insertedNodeId = "n-missing";
  assert.throws(() => parseLearningPath(unknownInsertedNode), /unknown inserted node id "n-missing"/);

  assert.deepEqual(PIVOT_PROPOSAL_TYPES, ["bridge", "contrast", "skill", "holistic"]);
});

test("every error category is a cognitive root cause, not a number", () => {
  assert.deepEqual(ERROR_CATEGORIES, [
    "misconception",
    "discrimination_error",
    "prerequisite_gap",
    "procedural_slip",
    "cue_failure",
  ]);
});

test("source anchors and spines are validated", () => {
  const emptyAnchor = rawPath();
  emptyAnchor.modules[0].nodes[0].sourceAnchor.reference = "   ";
  assert.throws(() => parseLearningPath(emptyAnchor), /sourceAnchor\.reference/);

  const emptySpine = rawPath();
  emptySpine.sourceSpine.references = [];
  assert.throws(() => parseLearningPath(emptySpine), /references: must contain at least one entry/);

  const uploaded = makePath();
  const uploadedPath: LearningPath = {
    ...uploaded,
    sourceSpine: {
      mode: "uploaded",
      sources: [
        {
          sourceId: "0f8fad5b-d9cb-469f-a165-70867728950e",
          name: "notes.md",
          uploadedAt: AT,
          byteSize: 120,
        },
      ],
      supplements: [{ title: "OSTEP", kind: "textbook" }],
    },
  };
  assert.equal(parseLearningPath(uploadedPath).sourceSpine.mode, "uploaded");

  const badSourceId = JSON.parse(JSON.stringify(uploadedPath));
  badSourceId.sourceSpine.sources[0].sourceId = "notes-md";
  assert.throws(() => parseLearningPath(badSourceId), /sourceId: must be a UUID/);

  const badSpineMode = rawPath();
  badSpineMode.sourceSpine.mode = "mixed";
  assert.throws(() => parseLearningPath(badSpineMode), /sourceSpine\.mode: must be one of/);
});

test("interleaving references must resolve inside the path and never point at the node itself", () => {
  const unknown = rawPath();
  unknown.modules[0].nodes[1].interleavesNodeIds = ["n-missing"];
  const result = validateLearningPath(unknown);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.issues[0]!.message, /unknown node id "n-missing"/);

  const self = rawPath();
  self.modules[0].nodes[1].interleavesNodeIds = ["n-concept"];
  assert.throws(() => parseLearningPath(self), /must not reference the node itself/);

  const duplicateId = rawPath();
  duplicateId.modules[1].nodes[0].id = "n-concept";
  assert.throws(() => parseLearningPath(duplicateId), /duplicate node id "n-concept"/);

  const duplicateModule = rawPath();
  duplicateModule.modules[1].id = "module-structure";
  assert.throws(() => parseLearningPath(duplicateModule), /duplicate module id "module-structure"/);
});

test("a path needs modules, modules need nodes, and required fields are required", () => {
  const noModules = rawPath();
  noModules.modules = [];
  assert.throws(() => parseLearningPath(noModules), /modules: a path needs at least one module/);

  const noNodes = rawPath();
  noNodes.modules[1].nodes = [];
  assert.throws(() => parseLearningPath(noNodes), /nodes: a module needs at least one node/);

  const noGoal = rawPath();
  delete noGoal.goal;
  assert.throws(() => parseLearningPath(noGoal), /path\.goal: must be a string/);

  const badTimestamp = rawPath();
  badTimestamp.updatedAt = "31 January 2026";
  assert.throws(() => parseLearningPath(badTimestamp), /updatedAt: must be an ISO-8601 UTC timestamp/);

  const untrimmed = rawPath();
  untrimmed.title = " Padded ";
  assert.throws(() => parseLearningPath(untrimmed), /must not have leading or trailing whitespace/);

  assert.throws(() => parseLearningPath([makePath()]), /path: must be an object/);
});

test("unknown keys are dropped, so only validated data reaches the store", () => {
  const value = rawPath();
  value.modules[0].nodes[0].schedule = "Monday";
  value.extra = { anything: true };
  const validated = parseLearningPath(value);
  assert.equal("extra" in validated, false);
  assert.equal("schedule" in validated.modules[0]!.nodes[0]!, false);
});

test("artifact catalog covers every type with a pedagogical justification", () => {
  assert.deepEqual(
    ARTIFACT_CATALOG.map((entry) => entry.type),
    [...ARTIFACT_TYPES],
  );
  for (const entry of ARTIFACT_CATALOG) {
    assert.ok(entry.label.length > 3, `${entry.type} needs a label`);
    assert.ok(entry.justification.length > 40, `${entry.type} needs a real justification`);
    assert.ok(entry.bestFor.length > 0, `${entry.type} needs at least one node type`);
    assert.deepEqual(artifactCatalogEntry(entry.type), entry);
  }
  assert.deepEqual(recommendedArtifactsFor("holistic"), ["relational_map"]);
  assert.deepEqual(recommendedArtifactsFor("contrast"), ["relational_map", "encoding_exercise"]);
  assert.deepEqual(recommendedArtifactsFor("bridge"), ["encoding_exercise"]);
  assert.deepEqual(recommendedArtifactsFor("checkpoint"), ["micro_code"]);
  assert.equal(defaultArtifactFor("concept"), "micro_code");
  assert.equal(defaultArtifactFor("skill"), "micro_code");
  assert.equal(ARTIFACT_TYPES.length, 6);
});

test("formats a source anchor for prompts without inventing missing parts", () => {
  assert.equal(
    formatSourceAnchor({ reference: "OSTEP", chapter: "26", section: "27.1", pages: "301-320" }),
    "OSTEP — chapter 26, section 27.1, pages 301-320",
  );
  assert.equal(formatSourceAnchor({ reference: "OSTEP" }), "OSTEP");
  assert.equal(formatSourceAnchor({ reference: "OSTEP", section: "3.1" }), "OSTEP — section 3.1");
});

test("plugin settings validate artifact defaults per node type", () => {
  assert.deepEqual(parsePluginSettings({}), { artifactDefaults: {} });
  const settings = parsePluginSettings({ artifactDefaults: { contrast: "relational_map", bridge: "none" } });
  assert.equal(settings.artifactDefaults.contrast, "relational_map");
  assert.equal(settings.artifactDefaults.bridge, "none");

  assert.throws(
    () => parsePluginSettings({ artifactDefaults: { lecture: "micro_code" } }),
    /unknown node type "lecture"/,
  );
  assert.throws(
    () => parsePluginSettings({ artifactDefaults: { concept: "video" } }),
    /artifactDefaults\.concept: must be one of/,
  );
  const result = validatePluginSettings({ artifactDefaults: { concept: "video" } });
  assert.equal(result.ok, false);
});
