/** Learning Paths Settings page tests.
 *
 * The page configures artifact defaults with the framework's justification,
 * switches between the host strong slot and an explicit Architect model/thinking
 * override, and confirms safe deletion. These tests mount the real page against
 * the recorded host UI and in-memory backend.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearningPath } from "../src/domain.ts";
import { mountSettingsPage } from "../src/settings.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture } from "./view-host.ts";
import type { MountRecord, ViewFixture } from "./view-host.ts";

function artifactRow(record: MountRecord, key: string) {
  return record.props.rows.find((row: { key: string }) => row.key === key);
}

function liveRows(fixture: ViewFixture, key: string): MountRecord {
  return fixture.findLast(
    "mountSettingsRows",
    (record) => record.props.rows.some((row: { key: string }) => row.key === key),
  );
}

test("settings page edits justified artifact defaults and persists them", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    mountSettingsPage(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();

    assert.match(fixture.root.textContent ?? "", /Learning Paths/);
    assert.match(fixture.root.textContent ?? "", /Why the framework recommends each artifact/);
    assert.match(fixture.root.textContent ?? "", /Eliminates hand-waving/);
    assert.match(fixture.root.textContent ?? "", /Externalizes mental structure/);
    assert.match(fixture.root.textContent ?? "", /Harnesses the generation effect/);

    const artifactRows = fixture.find(
      "mountSettingsRows",
      (record) => record.props.rows.length === 6,
    );
    const concept = artifactRow(artifactRows, "artifact-concept");
    assert.equal(concept.type, "dropdown");
    assert.equal(concept.value, "", "no plugin default is saved yet");
    assert.match(concept.description, /Recommended: .*Micro-code \/ implementation/);
    assert.match(concept.description, /Derivation \/ worked trace/);
    assert.match(concept.description, /Eliminates hand-waving/);
    assert.deepEqual(
      concept.options.map((option: { value: string }) => option.value),
      ["", "micro_code", "relational_map", "encoding_exercise", "derivation_trace", "retrieval_cue", "none"],
    );

    await concept.onChange("derivation_trace");
    await fixture.flush();

    assert.equal(fixture.settings.artifactDefaults.concept, "derivation_trace");
    assert.deepEqual(
      fixture.calls.filter((call) => call.name === "settings.save").at(-1)?.input,
      { artifactDefaults: { concept: "derivation_trace" } },
    );
    const updated = artifactRow(liveRows(fixture, "artifact-concept"), "artifact-concept");
    assert.equal(updated.value, "derivation_trace");
    assert.match(updated.description, /Verifies step-by-step causal continuity/);
    assert.match(fixture.root.textContent ?? "", /Settings saved/);

    // Clearing the plugin default falls back to the framework recommendation.
    await updated.onChange("");
    await fixture.flush();
    assert.deepEqual(fixture.settings.artifactDefaults, {});
    const cleared = artifactRow(liveRows(fixture, "artifact-concept"), "artifact-concept");
    assert.equal(cleared.value, "");
    assert.match(cleared.description, /Eliminates hand-waving/);
  } finally {
    fixture.restore();
  }
});

test("settings page switches Architect model preference between host slot and override", async () => {
  const fixture = createViewFixture({
    settings: { artifactDefaults: {}, architect: { followHostSlot: true } },
  });
  try {
    mountSettingsPage(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();

    assert.equal(fixture.all("mountModelPicker").length, 0, "following the host exposes no override pickers");
    assert.match(fixture.root.textContent ?? "", /Following the host strong slot/);

    const followRow = () =>
      artifactRow(liveRows(fixture, "architect-follow-host"), "architect-follow-host");
    assert.equal(followRow().value, true);
    await followRow().onChange(false);
    await fixture.flush();

    assert.equal(fixture.all("mountModelPicker").length, 1);
    assert.equal(fixture.all("mountThinkingPicker").length, 1);
    assert.match(fixture.root.textContent ?? "", /Choose a model to finish the override/);
    assert.equal(
      fixture.calls.some((call) => call.name === "settings.save" && "architect" in (call.input as object)),
      false,
      "a half-configured override is not saved",
    );

    const modelPicker = fixture.find("mountModelPicker");
    assert.equal(modelPicker.props.value, undefined);
    await modelPicker.props.onChange({ provider: "test", id: "other-model" });
    await fixture.flush();

    assert.deepEqual(fixture.settings.architect, {
      followHostSlot: false,
      model: { provider: "test", id: "other-model" },
    });
    assert.equal(fixture.find("mountModelPicker").props.value.id, "other-model");
    assert.equal(fixture.find("mountThinkingPicker").props.value, undefined);

    // Changing the model resets thinking, so an unsupported previous level cannot leak.
    const thinking = fixture.find("mountThinkingPicker");
    await thinking.props.onChange("off");
    await fixture.flush();
    assert.deepEqual(fixture.settings.architect, {
      followHostSlot: false,
      model: { provider: "test", id: "other-model" },
      thinkingLevel: "off",
    });
    assert.equal(fixture.find("mountModelPicker").props.value.id, "other-model");
    assert.equal(fixture.find("mountThinkingPicker").props.value, "off");

    await followRow().onChange(true);
    await fixture.flush();
    assert.deepEqual(fixture.settings.architect, { followHostSlot: true });
    assert.equal(fixture.all("mountModelPicker").length, 0);
    assert.equal(fixture.all("mountThinkingPicker").length, 0);
  } finally {
    fixture.restore();
  }
});

test("path deletion asks for confirmation and never touches native chats", async () => {
  const path: LearningPath = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    mountSettingsPage(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();

    const deleteButton = () =>
      fixture.findLast("mountButton", (record) => record.props.label === "Delete path…");
    await deleteButton().props.onClick();
    await fixture.flush();

    const dialog = fixture.find("openDialog");
    assert.match(dialog.props.title, /Delete the learning path/);
    const content = dialog.contentContainer!;
    assert.match(content.textContent ?? "", /deletes the plugin's path record/);
    assert.match(content.textContent ?? "", /Native LearnHarness chats and Knowledge Graph records are never deleted/);
    assert.match(content.textContent ?? "", /6 node\(s\)/);

    const keep = fixture.findLast(
      "mountButton",
      (record) => record.props.label === "Keep path" && record.container.closest(".lp-dialog-content") !== null,
    );
    await keep.props.onClick();
    await fixture.flush();
    assert.ok(dialog.disposed >= 1, "Keep path closes the dialog");
    assert.equal(fixture.calls.filter((call) => call.name === "paths.delete").length, 0);
    assert.ok(fixture.paths.has(path.id));

    await deleteButton().props.onClick();
    await fixture.flush();
    const confirm = fixture.findLast(
      "mountButton",
      (record) => record.props.label === "Delete path" && record.container.closest(".lp-dialog-content") !== null,
    );
    await confirm.props.onClick();
    await fixture.flush();

    assert.deepEqual(
      fixture.calls.filter((call) => call.name === "paths.delete").at(-1)?.input,
      { pathId: path.id },
    );
    assert.equal(fixture.paths.size, 0, "only the plugin path record is removed");
    assert.ok(fixture.nativeChats.has("chat-1"), "the linked native chat still exists");
    assert.match(fixture.root.textContent ?? "", /native chats and Knowledge Graph records were not touched/);
    assert.match(fixture.root.textContent ?? "", /No learning paths yet/);
  } finally {
    fixture.restore();
  }
});
