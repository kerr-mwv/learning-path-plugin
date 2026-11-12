/** Path Hub frontend tests.
 *
 * Public-API test double only: the real view is mounted against a recorded host
 * UI and an in-memory JSON backend. These tests prove disposal, tree rendering
 * and navigation, Architect chat state, document-conversion failures and
 * `onResync` recovery without a browser or a model request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginAgentSnapshot, PluginTreeRow } from "learnharness-plugin-api";
import { mountPathHub } from "../src/view/path-hub.ts";
import { effectiveArtifact } from "../src/view/node-inspector.ts";
import { ARTIFACT_CATALOG } from "../src/domain.ts";
import type { LearningPath } from "../src/domain.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture, fire, makeConversation, setSelect } from "./view-host.ts";
import type { MountRecord, ViewFixture } from "./view-host.ts";

function assistant(text: string): PluginAgentSnapshot["messages"][number] {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  } as unknown as PluginAgentSnapshot["messages"][number];
}

function user(text: string): PluginAgentSnapshot["messages"][number] {
  return { role: "user", content: text, timestamp: Date.now() };
}

function snapshot(id: string, overrides: Partial<PluginAgentSnapshot> = {}): PluginAgentSnapshot {
  return makeConversation(id, overrides);
}

function allRows(tree: MountRecord): PluginTreeRow[] {
  const rows: PluginTreeRow[] = [];
  const visit = (entries: readonly PluginTreeRow[]) => {
    for (const row of entries) {
      rows.push(row);
      if (row.children) visit(row.children);
    }
  };
  visit(tree.props.rows as readonly PluginTreeRow[]);
  return rows;
}

function row(tree: MountRecord, key: string): PluginTreeRow {
  const found = allRows(tree).find((entry) => entry.key === key);
  assert.ok(found, `Missing tree row ${key}; have ${allRows(tree).map((entry) => entry.key).join(", ")}`);
  return found;
}

async function mounted(fixture: ViewFixture): Promise<HTMLElement> {
  const container = fixture.root;
  fixture.context.signal.addEventListener("abort", () => container.replaceChildren());
  mountPathHub(fixture.context, container, fixture.context.signal);
  await fixture.flush();
  return container;
}

function liveButtons(fixture: ViewFixture): MountRecord[] {
  return fixture.all("mountButton");
}

test("Path Hub mounts every surface and disposes widgets, tree content and listeners on unmount", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect", { messages: [assistant("Here is a plan.")] })],
  });
  try {
    const container = await mounted(fixture);

    const tree = fixture.find("mountTree");
    assert.equal(tree.props.label, "Path hierarchy");
    assert.equal(tree.props.header, "Path");
    assert.deepEqual(tree.props.columns, [{ key: "state", header: "State", width: 136 }]);
    assert.equal(tree.signal, fixture.context.signal);
    assert.equal(fixture.all("mountStandardComposer").length, 1);
    assert.equal(fixture.all("mountMarkdown").length, 1, "the stored Architect turn is rendered as Markdown");
    assert.ok(liveButtons(fixture).some((button) => button.props.label === "Create a Path"));
    assert.ok(liveButtons(fixture).some((button) => button.props.label === "Refine Path"));
    assert.ok(liveButtons(fixture).some((button) => button.props.label === "Upload PDF or text"));
    assert.ok(fixture.all("mountBadge").length >= 6, "node type and progression badges mount inside tree content");
    assert.match(container.textContent ?? "", /1 of 6 nodes consolidated/);

    const callsBefore = fixture.calls.length;
    fixture.controller.abort();
    await fixture.flush();

    assert.equal(container.childElementCount, 0, "the view root removes itself");
    assert.ok(fixture.records.length > 0);
    assert.ok(
      fixture.records.every((record) => record.disposed >= 1),
      "every ctx.ui handle, including tree content, is disposed exactly through its signal",
    );

    fixture.emit("paths-changed", { id: path.id });
    fixture.resync();
    await fixture.flush();
    assert.equal(fixture.calls.length, callsBefore, "aborted listeners stop refetching");
  } finally {
    fixture.restore();
  }
});

test("tree renders modules, nodes and child chats with badges and preserves selection across updates", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const tree = fixture.find("mountTree");
    assert.deepEqual(
      allRows(tree).map((entry) => entry.key),
      [
        "module:module-structure",
        "node:n-holistic",
        "node:n-concept",
        "chat:n-concept:chat-1",
        "node:n-skill",
        "module:module-synthesis",
        "node:n-contrast",
        "node:n-checkpoint",
        "node:n-bridge",
      ],
    );
    assert.equal(row(tree, "module:module-structure").content, "Structure first");
    assert.equal(row(tree, "module:module-structure").cells?.state, "1/3 consolidated");
    assert.deepEqual(
      fixture.all("mountBadge").slice(0, 6).map((badge) => badge.props.text),
      ["Holistic", "Consolidated", "Concept", "In progress", "Skill", "Unstarted"],
    );

    const initialArchitectCalls = fixture.calls.filter((call) => call.name.startsWith("architect")).length;
    await row(tree, "node:n-concept").selection!.onChange(true);
    await fixture.flush();
    const inspector = fixture.root.querySelector<HTMLElement>(".lp-inspector")!;
    assert.equal(inspector.dataset.nodeId, "n-concept");
    assert.match(inspector.textContent ?? "", /Understand n-concept from first principles\./);
    assert.match(inspector.textContent ?? "", /OSTEP — chapter 26, section 27\.1, pages 301-320/);
    assert.match(inspector.textContent ?? "", /Skim the module overview and the running example\./);
    assert.match(inspector.textContent ?? "", /Why the framework recommends this/);
    assert.match(inspector.textContent ?? "", /Eliminates hand-waving/);
    assert.equal(
      inspector.querySelector<HTMLSelectElement>('select[aria-label="Artifact type"]')!.value,
      "micro_code",
    );

    const interleaved = liveButtons(fixture).find((button) => button.props.label === "Node n-holistic");
    assert.ok(interleaved, "interleaved prior nodes are followable links");
    await interleaved.props.onClick();
    assert.equal(fixture.root.querySelector<HTMLElement>(".lp-inspector")!.dataset.nodeId, "n-holistic");

    await row(tree, "module:module-structure").disclosure!.onChange(false);
    assert.equal(row(tree, "module:module-structure").disclosure!.expanded, false);
    assert.equal(row(tree, "node:n-holistic").selection!.checked, true, "selection survives collapse/re-render");
    assert.equal(
      fixture.root.querySelector<HTMLElement>(".lp-inspector")!.dataset.nodeId,
      "n-holistic",
      "collapsing the tree never clears the inspector selection",
    );
    await row(tree, "module:module-structure").disclosure!.onChange(true);
    assert.equal(row(tree, "module:module-structure").disclosure!.expanded, true);

    const chatButton = liveButtons(fixture).find(
      (button) => button.props.label === "Open" && button.container.closest(".lp-tree-chat"),
    );
    assert.ok(chatButton, "child-chat rows expose a navigation action inside the tree");
    await chatButton.props.onClick();
    assert.deepEqual(fixture.openedSessions, ["chat-1"]);
    assert.equal(
      fixture.calls.filter((call) => call.name.startsWith("architect")).length,
      initialArchitectCalls,
      "tree navigation and expansion never refetch or restart the Architect",
    );
  } finally {
    fixture.restore();
  }
});

test("node inspector persists progression and artifact choices and refreshes badges and progress", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    const tree = fixture.find("mountTree");
    await row(tree, "node:n-concept").selection!.onChange(true);

    const progression = fixture.root.querySelector<HTMLSelectElement>('select[aria-label="Progression"]')!;
    setSelect(progression, "consolidated");
    await fixture.flush();
    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.updateNode").at(-1)?.input, {
      pathId: path.id,
      nodeId: "n-concept",
      progression: "consolidated",
    });
    assert.match(fixture.root.textContent ?? "", /2 of 6 nodes consolidated · 1 in progress/);
    const conceptRow = row(fixture.find("mountTree"), "node:n-concept");
    assert.equal(conceptRow.cells?.state, "Consolidated");
    assert.ok(
      fixture
        .all("mountBadge")
        .some((badge) => badge.props.text === "Consolidated" && badge.container.closest(".lp-tree-node")),
    );

    const artifact = fixture.root.querySelector<HTMLSelectElement>('select[aria-label="Artifact type"]')!;
    setSelect(artifact, "relational_map");
    await fixture.flush();
    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.updateNode").at(-1)?.input, {
      pathId: path.id,
      nodeId: "n-concept",
      artifactType: "relational_map",
    });
    const updated = fixture.paths.get(path.id)!;
    const node = updated.modules[0]!.nodes.find((candidate) => candidate.id === "n-concept")!;
    assert.equal(effectiveArtifact(updated, node), "relational_map");
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-artifact-justification")!.textContent ?? "",
      /Externalizes mental structure/,
    );

    // Clearing the override falls back to the path default and keeps the card justified.
    setSelect(artifact, "");
    await fixture.flush();
    const afterClear = fixture.paths.get(path.id)!;
    assert.equal(
      afterClear.modules[0]!.nodes.find((candidate) => candidate.id === "n-concept")!.artifactConfig,
      null,
    );
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-artifact-justification")!.textContent ?? "",
      /Crystallizes atomic hooks/,
      "the path default (retrieval cue) now supplies the justification",
    );
    assert.equal(ARTIFACT_CATALOG.length, 6);
  } finally {
    fixture.restore();
  }
});

test("Architect chat sends, shows busy state and adopts notification snapshots as Markdown turns", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [
      snapshot("chat-architect", { messages: [user("Build me a linear algebra path."), assistant("Here is a plan.")] }),
    ],
  });
  try {
    await mounted(fixture);
    assert.equal(fixture.all("mountMarkdown").length, 1);
    assert.equal(fixture.find("mountMarkdown").props.text, "Here is a plan.");

    const composer = fixture.find("mountStandardComposer");
    assert.equal(composer.props.composer.value, "");
    assert.equal(composer.props.composer.busy, false);
    assert.equal(typeof composer.props.composer.onStop, "function");
    assert.equal(typeof composer.props.dictation.onTranscript, "function");

    await composer.props.composer.onChange("Refine module two.");
    assert.equal(fixture.find("mountStandardComposer").props.composer.value, "Refine module two.");

    await composer.props.composer.onSend();
    await fixture.flush();
    const send = fixture.calls.filter((call) => call.name === "architect.send").at(-1);
    assert.ok(send);
    assert.deepEqual(
      { id: (send.input as { id: string }).id, text: (send.input as { text: string }).text },
      { id: "chat-architect", text: "Refine module two." },
    );
    assert.equal(fixture.find("mountStandardComposer").props.composer.busy, true);
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-architect-status")!.textContent ?? "",
      /Architect is thinking/,
    );

    const updated = structuredClone(fixture.conversations.get("chat-architect")!);
    updated.status = "idle";
    updated.messages = [...updated.messages, assistant("Module two now has a contrast node.")];
    fixture.conversations.set("chat-architect", updated);
    fixture.emit("architect-changed", { id: "chat-architect", kind: "state", status: "idle" });
    await fixture.flush();

    assert.equal(fixture.find("mountStandardComposer").props.composer.busy, false);
    assert.ok(
      fixture.all("mountMarkdown").some((markdown) => markdown.props.text === "Module two now has a contrast node."),
    );
    assert.equal(fixture.find("mountStandardComposer").props.composer.value, "");

    // Create a Path starts a fresh Architect conversation and opens the refine surface.
    const create = liveButtons(fixture).find((button) => button.props.label === "Create a Path")!;
    await create.props.onClick();
    await fixture.flush();
    assert.equal(fixture.calls.filter((call) => call.name === "architect.create").length, 0,
      "opening the composer must leave time to select a model before creating a conversation");
    assert.equal(fixture.find("mountStandardComposer").props.model.disabled, false);
    fixture.emit("paths-changed", { id: path.id });
    await fixture.flush();
    assert.equal(fixture.find("mountStandardComposer").props.model.disabled, false,
      "a path refresh must not replace the new model-selection draft with the old chat");
    assert.ok(
      liveButtons(fixture).some((button) => button.props.label === "Refine Path · on"),
      "Create a Path opens the Architect surface",
    );
    assert.equal(fixture.root.querySelector<HTMLElement>(".lp-architect-pane")!.hidden, false);
  } finally {
    fixture.restore();
  }
});

test("a new path chooses its Architect model before the conversation is created", async () => {
  const fixture = createViewFixture();
  try {
    await mounted(fixture);
    const composer = fixture.find("mountStandardComposer");
    assert.match(fixture.root.querySelector(".lp-model-hint")?.textContent ?? "", /configured default/);
    await composer.props.model.onChange({ provider: "custom", id: "chosen-architect" });
    assert.equal(composer.props.thinking.value, undefined);
    await composer.props.thinking.onChange("high");
    await composer.props.model.onChange({ provider: "custom", id: "another-model" });
    assert.equal(composer.props.thinking.value, undefined, "changing models clears incompatible thinking");
    await composer.props.model.onChange({ provider: "custom", id: "chosen-architect" });
    await composer.props.thinking.onChange("high");
    await liveButtons(fixture).find((button) => button.props.label === "Create a Path")!.props.onClick();
    assert.deepEqual(composer.props.model.value, { provider: "custom", id: "chosen-architect" },
      "opening an already-empty draft does not discard a model choice");
    await composer.props.composer.onChange("Teach me geometry");
    await composer.props.composer.onSend();
    await fixture.flush();
    const created = fixture.calls.find((call) => call.name === "architect.create");
    assert.deepEqual((created?.input as { model: unknown }).model,
      { provider: "custom", id: "chosen-architect", thinkingLevel: "high" });
    assert.ok(fixture.calls.some((call) => call.name === "architect.send"));
    assert.equal(composer.props.model.disabled, true, "the model is fixed for this conversation");
    await composer.props.composer.onStop();
    await fixture.flush();
    const newPath = liveButtons(fixture).find((button) => button.props.label === "Create a Path")!;
    await newPath.props.onClick();
    assert.equal(composer.props.model.disabled, false);
    assert.equal(composer.props.model.value, undefined);
    assert.equal(composer.props.thinking.value, undefined);
    assert.equal(fixture.calls.filter((call) => call.name === "architect.create").length, 1);
  } finally {
    fixture.restore();
  }
});

test("Architect shows streamed reasoning and tool activity while a path is being built", async () => {
  const fixture = createViewFixture({ paths: [makePath()], conversations: [snapshot("chat-architect", { status: "running" })] });
  try {
    await mounted(fixture);
    const progress = structuredClone(fixture.conversations.get("chat-architect")!);
    progress.partial = { role: "assistant", content: [
      { type: "thinking", thinking: "Map the chapter headings to the concepts." },
      { type: "toolCall", name: "read_uploaded_source_chunk", id: "call-1", arguments: {} },
      { type: "text", text: "Drafting the outline…" },
    ] } as unknown as PluginAgentSnapshot["partial"];
    fixture.conversations.set("chat-architect", progress);
    fixture.emit("architect-changed", { id: "chat-architect" });
    await fixture.flush();
    assert.match(fixture.root.querySelector(".lp-chat-reasoning")?.textContent ?? "", /Map the chapter headings/);
    assert.match(fixture.root.querySelector(".lp-chat-activity")?.textContent ?? "", /read_uploaded_source_chunk/);
    assert.ok(fixture.all("mountMarkdown").some((mount) => mount.props.text === "Drafting the outline…"));
  } finally {
    fixture.restore();
  }
});

test("background refreshes keep the conversation in view and select the path it creates", async () => {
  const fixture = createViewFixture({ paths: [makePath()], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    await liveButtons(fixture).find((button) => button.props.label === "Create a Path")!.props.onClick();
    const composer = fixture.find("mountStandardComposer");
    await composer.props.composer.onChange("Teach me shaders");
    await composer.props.composer.onSend();
    await fixture.flush();
    const created = fixture.calls.find((call) => call.name === "architect.create");
    assert.ok(created);
    const newChat = [...fixture.conversations.keys()].find((id) => id !== "chat-architect")!;
    const loads = () => fixture.calls.filter((call) => call.name === "architect.get" &&
      (call.input as { id: string }).id === "chat-architect").length;
    const before = loads();

    // Child-chat progress on the selected path must not switch the pane back.
    fixture.emit("paths-changed", { id: "path-linear-algebra" });
    await fixture.flush();
    assert.equal(loads(), before, "the running new conversation stays in view");

    // The new conversation saves its path: the hub selects it.
    const shaders = { ...makePath(), id: "path-shaders", title: "Shaders", architectChatId: newChat };
    fixture.paths.set(shaders.id, shaders);
    fixture.emit("paths-changed", { id: shaders.id, created: true });
    await fixture.flush();
    assert.equal(loads(), before);
    assert.equal(fixture.root.querySelector<HTMLSelectElement>("select")?.value, "path-shaders");
  } finally {
    fixture.restore();
  }
});

test("Refine Path over an unsent draft opens the selected path's conversation", async () => {
  const fixture = createViewFixture({ paths: [makePath()], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    await liveButtons(fixture).find((button) => button.props.label === "Create a Path")!.props.onClick();
    await fixture.flush();
    assert.equal(fixture.find("mountStandardComposer").props.model.disabled, false, "a new draft is open");
    const refine = () => liveButtons(fixture).find((button) => String(button.props.label).startsWith("Refine Path"))!;
    await refine().props.onClick(); // close
    await refine().props.onClick(); // reopen for the selected path
    await fixture.flush();
    assert.equal(fixture.find("mountStandardComposer").props.model.disabled, true,
      "the path's existing conversation replaced the draft");
    assert.equal(fixture.calls.filter((call) => call.name === "architect.create").length, 0);
  } finally {
    fixture.restore();
  }
});

test("streamed progress re-renders only the live turn, not the committed history", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect", {
      status: "running",
      messages: [user("Build a path"), assistant("First outline."), assistant("Second outline.")],
    })],
  });
  try {
    await mounted(fixture);
    const historyMounts = () => fixture.all("mountMarkdown").filter((mount) =>
      mount.props.text === "First outline." || mount.props.text === "Second outline.").length;
    const initial = historyMounts();
    assert.equal(initial, 2);
    const fullReads = () => fixture.calls.filter((call) => call.name === "architect.get").length;
    const readsBefore = fullReads();
    for (const text of ["Draft…", "Draft, more…"]) {
      const progress = structuredClone(fixture.conversations.get("chat-architect")!);
      progress.partial = { role: "assistant", content: [{ type: "text", text }] } as unknown as PluginAgentSnapshot["partial"];
      fixture.conversations.set("chat-architect", progress);
      fixture.emit("architect-changed", { id: "chat-architect", messageCount: 3, partial: true });
      await fixture.flush();
    }
    assert.equal(historyMounts(), initial, "history markdown is not remounted per progress tick");
    assert.ok(fixture.all("mountMarkdown").some((mount) => mount.props.text === "Draft, more…"));
    assert.equal(fullReads(), readsBefore, "progress ticks never refetch the committed history");
    assert.equal(fixture.calls.filter((call) => call.name === "architect.progress").length, 2);

    // A committed message changes the count: the full conversation is reloaded.
    const committed = structuredClone(fixture.conversations.get("chat-architect")!);
    committed.messages = [...committed.messages, assistant("Third outline.")];
    delete committed.partial;
    committed.status = "idle";
    fixture.conversations.set("chat-architect", committed);
    fixture.emit("architect-changed", { id: "chat-architect", messageCount: 4, partial: false });
    await fixture.flush();
    assert.equal(fullReads(), readsBefore + 1);
    assert.ok(fixture.all("mountMarkdown").some((mount) => mount.props.text === "Third outline."));
    assert.ok(!fixture.root.querySelector(".lp-chat-partial"), "the finished partial is gone");
  } finally {
    fixture.restore();
  }
});

test("document upload surfaces conversion errors without saving and saves on success", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path], conversations: [snapshot("chat-architect")] });
  try {
    await mounted(fixture);
    const input = fixture.root.querySelector<HTMLInputElement>('input[type="file"]')!;
    assert.ok(input, "the Architect surface owns a native file picker");
    const file = new File(["not text"], "broken.pdf", { type: "application/pdf" });

    fixture.toMarkdown = async () => {
      throw new Error("Only UTF-8 text or a valid PDF can be converted.");
    };
    Object.defineProperty(input, "files", { configurable: true, value: { item: () => file } });
    fire(input, "change");
    await fixture.flush();

    const status = () => fixture.root.querySelector<HTMLElement>(".lp-upload-status")!;
    assert.equal(status().dataset.state, "error");
    assert.match(status().textContent ?? "", /Could not use broken\.pdf/);
    assert.match(status().textContent ?? "", /Only UTF-8 text or a valid PDF/);
    assert.equal(fixture.uploaded.length, 0, "a failed conversion never reaches sources.save");
    assert.equal(fixture.calls.filter((call) => call.name === "sources.save").length, 0);
    assert.equal(fixture.find("mountStandardComposer").props.composer.value, "", "the draft is untouched");

    const good = new File(["# Book"], "book.md", { type: "text/markdown" });
    fixture.toMarkdown = async () => ({
      name: "book.md",
      markdown: "# Book\n\nConverted content.",
      notices: ["Page 2 was image-only and was skipped."],
    });
    Object.defineProperty(input, "files", { configurable: true, value: { item: () => good } });
    fire(input, "change");
    await fixture.flush();

    assert.deepEqual(fixture.uploaded, [{ name: "book.md", markdown: "# Book\n\nConverted content." }]);
    assert.equal(status().dataset.state, "success");
    assert.match(status().textContent ?? "", /Added book\.md/);
    assert.match(status().textContent ?? "", /Page 2 was image-only/);
    assert.equal(fixture.calls.filter((call) => call.name === "sources.save").length, 1);
  } finally {
    fixture.restore();
  }
});

test("onResync re-reads paths and the Architect conversation after missed notifications", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect", { messages: [assistant("First plan.")] })],
  });
  try {
    await mounted(fixture);
    assert.match(fixture.root.querySelector<HTMLElement>(".lp-goal")!.textContent ?? "", /Build durable/);

    const changed: LearningPath = {
      ...path,
      goal: "Updated goal after reconnect.",
      updatedAt: "2026-02-02T00:00:00.000Z",
    };
    fixture.paths.set(path.id, changed);
    const conversation = structuredClone(fixture.conversations.get("chat-architect")!);
    conversation.messages = [...conversation.messages, assistant("Recovered plan after reconnect.")];
    fixture.conversations.set("chat-architect", conversation);
    await fixture.flush();
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-goal")!.textContent ?? "",
      /Build durable/,
      "a missed notification leaves the view stale",
    );

    const before = fixture.calls.length;
    fixture.resync();
    await fixture.flush();
    const names = fixture.calls.slice(before).map((call) => call.name);
    assert.ok(names.includes("paths.list"));
    assert.ok(names.includes("paths.get"));
    assert.ok(names.includes("architect.get"));
    assert.match(
      fixture.root.querySelector<HTMLElement>(".lp-goal")!.textContent ?? "",
      /Updated goal after reconnect\./,
    );
    assert.ok(
      fixture.all("mountMarkdown").some((markdown) => markdown.props.text === "Recovered plan after reconnect."),
      "the Architect transcript recovers from the authoritative snapshot",
    );

    const callsAfterResync = fixture.calls.length;
    fixture.controller.abort();
    fixture.resync();
    await fixture.flush();
    assert.equal(fixture.calls.length, callsAfterResync, "resync listeners are released with the view");
  } finally {
    fixture.restore();
  }
});

test("an empty hub offers Create a Path and does not invent a tree or inspector node", async () => {
  const fixture = createViewFixture();
  try {
    await mounted(fixture);
    assert.equal(fixture.root.querySelector<HTMLElement>(".lp-architect-pane")!.hidden, false);
    assert.match(fixture.root.textContent ?? "", /No learning paths yet/);
    assert.match(fixture.root.querySelector<HTMLElement>(".lp-inspector")!.textContent ?? "", /Select a node/);
    assert.equal(fixture.all("mountTree").length, 0, "no empty tree is mounted without a path");
    const create = liveButtons(fixture).find((button) => button.props.label === "Create a Path")!;
    await create.props.onClick();
    await fixture.flush();
    assert.equal(fixture.conversations.size, 0, "opening a draft does not lock in the model yet");
    assert.equal(fixture.paths.size, 0, "the Architect creates paths through save_learning_path, not the header");
    assert.ok(fixture.all("mountMarkdown").length === 0);
  } finally {
    fixture.restore();
  }
});
