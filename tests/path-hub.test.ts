/** Path Hub frontend tests.
 *
 * Public-API test double only: the real view is mounted against a recorded host
 * UI and an in-memory JSON backend. These tests prove disposal, roadmap
 * rendering and navigation, Architect chat state, document-conversion failures and
 * `onResync` recovery without a browser or a model request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginAgentSnapshot } from "learnharness-plugin-api";
import { mountPathHub } from "../src/view/path-hub.ts";
import { effectiveArtifact } from "../src/view/node-inspector.ts";
import { ARTIFACT_CATALOG } from "../src/domain.ts";
import type { LearningPath } from "../src/domain.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture, fire, makeConversation, roadmapCard, selectRoadmapCard, setSelect } from "./view-host.ts";
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

function liveButtons(fixture: ViewFixture): MountRecord[] {
  return fixture.all("mountButton");
}

/** A pointer event carrying the fields the bar's drag handler reads; the
 * test double's generic Event carries none of them by default. */
function pointerEvent(
  document: Document,
  type: string,
  fields: { pointerId?: number; clientX?: number; clientY?: number; button?: number } = {},
): Event {
  const event = document.createEvent("Event");
  event.initEvent(type, true, true);
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  return event;
}

async function mounted(fixture: ViewFixture): Promise<HTMLElement> {
  const container = fixture.root;
  fixture.context.signal.addEventListener("abort", () => container.replaceChildren());
  mountPathHub(fixture.context, container, fixture.context.signal);
  await fixture.flush();
  return container;
}

test("Path Hub mounts every surface and disposes widgets, roadmap cards and listeners on unmount", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect", { messages: [assistant("Here is a plan.")] })],
  });
  try {
    const container = await mounted(fixture);

    assert.equal(fixture.all("mountTree").length, 0, "the host tree widget is gone from the Path Hub");
    assert.equal(
      container.querySelector<HTMLElement>(".lp-path-pane .lp-pane-title")!.textContent,
      "Path roadmap",
      "the roadmap is the path pane's lens, not a tree",
    );
    const lanes = container.querySelectorAll<HTMLElement>(".lp-lane");
    assert.equal(lanes.length, 2, "makePath()'s two modules are lanes");
    const cards = container.querySelectorAll<HTMLElement>(".lp-roadmap-card");
    assert.equal(cards.length, 6, "every node is a card");
    assert.ok(
      [...cards].every((card) => card.tagName === "BUTTON" && card.getAttribute("type") === "button"),
      "cards are real, keyboard-focusable buttons",
    );
    assert.equal(fixture.all("mountStandardComposer").length, 1);
    assert.equal(fixture.all("mountMarkdown").length, 1, "the stored Architect turn is rendered as Markdown");
    assert.ok(liveButtons(fixture).some((button) => button.props.label === "Create a Path"));
    assert.ok(liveButtons(fixture).some((button) => button.props.label === "Refine Path"));
    assert.ok(liveButtons(fixture).some((button) => button.props.label === "Upload PDF or text"));
    assert.ok(fixture.all("mountBadge").length >= 12, "node type and progression badges mount inside the cards");
    assert.match(container.textContent ?? "", /1 of 6 nodes consolidated/);

    const callsBefore = fixture.calls.length;
    fixture.controller.abort();
    await fixture.flush();

    assert.equal(container.childElementCount, 0, "the view root removes itself");
    assert.ok(fixture.records.length > 0);
    assert.ok(
      fixture.records.every((record) => record.disposed >= 1),
      "every ctx.ui handle, including card badges, is disposed exactly through its signal",
    );

    fixture.emit("paths-changed", { id: path.id });
    fixture.resync();
    await fixture.flush();
    assert.equal(fixture.calls.length, callsBefore, "aborted listeners stop refetching");
  } finally {
    fixture.restore();
  }
});

test("roadmap renders module lanes and node cards with badges and preserves selection across updates", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const lanes = [...fixture.root.querySelectorAll<HTMLElement>(".lp-lane")];
    assert.deepEqual(
      lanes.map((lane) => lane.querySelector(".lp-lane-title")?.textContent),
      ["Structure first", "Synthesis"],
    );
    assert.match(lanes[0]!.textContent ?? "", /1\/3 consolidated/);
    assert.match(lanes[1]!.textContent ?? "", /0\/3 consolidated/);
    assert.deepEqual(
      [...fixture.root.querySelectorAll<HTMLElement>(".lp-roadmap-card")].map(
        (card) => card.dataset.nodeId,
      ),
      ["n-holistic", "n-concept", "n-skill", "n-contrast", "n-checkpoint", "n-bridge"],
    );
    assert.match(
      roadmapCard(fixture.root, "n-concept").textContent ?? "",
      /1 teaching/,
      "child chats are counted on the card where they are linked",
    );
    assert.deepEqual(
      fixture
        .all("mountBadge")
        // Card badges mount into `lp-badge-row` hosts; overview and inspector
        // badges use `lp-badge-host`, so this scopes the assertion.
        .filter((badge) => badge.container.closest(".lp-roadmap-card") !== null)
        .slice(0, 6)
        .map((badge) => badge.props.text),
      ["Holistic", "Consolidated", "Concept", "In progress", "Skill", "Unstarted"],
    );

    const initialArchitectCalls = fixture.calls.filter((call) => call.name.startsWith("architect")).length;
    const conceptCard = selectRoadmapCard(fixture.root, "n-concept");
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

    assert.equal(
      roadmapCard(fixture.root, "n-concept").getAttribute("aria-pressed"),
      "true",
      "the selected card is marked",
    );
    assert.match(roadmapCard(fixture.root, "n-concept").className, /lp-roadmap-card-selected/);
    assert.equal(
      roadmapCard(fixture.root, "n-concept"),
      conceptCard,
      "selection repaints in place, so keyboard focus stays on the card",
    );

    const interleaved = liveButtons(fixture).find((button) => button.props.label === "Node n-holistic");
    assert.ok(interleaved, "interleaved prior nodes are followable links");
    await interleaved.props.onClick();
    assert.equal(fixture.root.querySelector<HTMLElement>(".lp-inspector")!.dataset.nodeId, "n-holistic");
    assert.equal(roadmapCard(fixture.root, "n-holistic").getAttribute("aria-pressed"), "true");
    assert.equal(roadmapCard(fixture.root, "n-concept").getAttribute("aria-pressed"), "false");

    // A path refresh rebuilds the cards; the selection belongs to the hub, not
    // to the DOM, so it survives the re-render with the inspector intact.
    fixture.emit("paths-changed", { id: path.id });
    await fixture.flush();
    assert.equal(
      roadmapCard(fixture.root, "n-holistic").getAttribute("aria-pressed"),
      "true",
      "selection survives a roadmap re-render",
    );
    assert.equal(
      fixture.root.querySelector<HTMLElement>(".lp-inspector")!.dataset.nodeId,
      "n-holistic",
      "re-rendering the roadmap never clears the inspector selection",
    );

    // Child chats stay openable from the inspector that the card selected into.
    selectRoadmapCard(fixture.root, "n-concept");
    await fixture.flush();
    await liveButtons(fixture).find((button) => button.props.label === "Actions")!.props.onClick();
    const menu = fixture.find("openMenu");
    assert.equal(menu.props.label, "Session actions for First teaching chat");
    const open = menu.props.items.find((item: { key: string }) => item.key === "open");
    assert.ok(open, "a linked child chat exposes a navigation action in the inspector");
    await open.onSelect();
    assert.deepEqual(fixture.openedSessions, ["chat-1"]);
    assert.equal(
      fixture.calls.filter((call) => call.name.startsWith("architect")).length,
      initialArchitectCalls,
      "roadmap navigation never refetches or restarts the Architect",
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
    selectRoadmapCard(fixture.root, "n-concept");

    const progression = fixture.root.querySelector<HTMLSelectElement>('select[aria-label="Progression"]')!;
    setSelect(progression, "consolidated");
    await fixture.flush();
    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.updateNode").at(-1)?.input, {
      pathId: path.id,
      nodeId: "n-concept",
      progression: "consolidated",
    });
    assert.match(fixture.root.textContent ?? "", /2 of 6 nodes consolidated · 1 in progress/);
    assert.ok(
      fixture
        .all("mountBadge")
        .some(
          (badge) =>
            badge.props.text === "Consolidated" &&
            badge.container.closest(".lp-roadmap-card")?.getAttribute("aria-pressed") === "true",
        ),
      "the selected card's progression badge updates with the record",
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

test("the detailed view floats: it never squeezes the roadmap, and Close deselects", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);

    // The inspector is a floating sibling of the body, not a grid column, so
    // the roadmap and the Architect conversation keep their full width.
    const body = fixture.root.querySelector<HTMLElement>(".lp-hub-body")!;
    const pane = fixture.root.querySelector<HTMLElement>(".lp-inspector-pane")!;
    assert.notEqual(pane.parentElement, body, "the detailed view is not a body column");
    assert.equal(pane.hidden, false, "the first selected node opens the floating details");

    const close = liveButtons(fixture).find((button) => button.props.label === "Close")!;
    assert.ok(close, "the floating pane carries a close control");
    await close.props.onClick();
    await fixture.flush();

    assert.equal(pane.hidden, true, "closing deselects and hides the floating window");
    assert.ok(!fixture.root.querySelector<HTMLElement>(".lp-inspector")!.dataset.nodeId);
    assert.equal(roadmapCard(fixture.root, "n-holistic").getAttribute("aria-pressed"), "false");

    // The live app refreshes in the background (notifications, resync). A
    // closed detailed view must stay closed instead of silently reselecting.
    fixture.emit("paths-changed", { id: path.id });
    await fixture.flush();
    fixture.resync();
    await fixture.flush();
    assert.equal(pane.hidden, true, "a background refresh never reopens the closed window");
    assert.ok(!fixture.root.querySelector<HTMLElement>(".lp-inspector")!.dataset.nodeId);
    assert.equal(
      body.querySelectorAll<HTMLElement>(":scope > *").length,
      2,
      "the body keeps exactly the roadmap pane and the Architect pane — the details and their workspace tab float",
    );

    // Reopening via a card click brings the same inspector back.
    await selectRoadmapCard(fixture.root, "n-concept");
    assert.equal(pane.hidden, false);
    assert.equal(fixture.root.querySelector<HTMLElement>(".lp-inspector")!.dataset.nodeId, "n-concept");
  } finally {
    fixture.restore();
  }
});

test("the floating details auto-hide their title bar on scroll and expand on demand", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);

    // The frame carries a drag grip; an inner scroller owns the overflow so
    // the grip never scrolls with the content, and the bar sits inside it.
    const pane = fixture.root.querySelector<HTMLElement>(".lp-inspector-pane")!;
    const scroller = pane.querySelector<HTMLElement>(".lp-inspector-scroll")!;
    const bar = pane.querySelector<HTMLElement>(".lp-inspector-bar")!;
    assert.ok(pane.querySelector(".lp-inspector-grip"), "the frame exposes a resize grip");
    assert.ok(!bar.classList.contains("lp-inspector-bar-hidden"), "the bar starts visible");

    // Scrolling down past the threshold fades the bar out of the way…
    scroller.scrollTop = 100;
    fire(scroller, "scroll");
    assert.ok(bar.classList.contains("lp-inspector-bar-hidden"), "scrolling down hides the bar");

    // …and scrolling back up brings the title, Expand and Close back.
    scroller.scrollTop = 40;
    fire(scroller, "scroll");
    assert.ok(!bar.classList.contains("lp-inspector-bar-hidden"), "scrolling up restores the bar");

    // Switching nodes rewinds to the top with the bar in place.
    scroller.scrollTop = 100;
    fire(scroller, "scroll");
    assert.ok(bar.classList.contains("lp-inspector-bar-hidden"));
    await selectRoadmapCard(fixture.root, "n-concept");
    assert.ok(!bar.classList.contains("lp-inspector-bar-hidden"), "a fresh node starts unscrolled");

    // Expand stretches the window across the hub; Restore brings it back. Both
    // are icon-only: the label stays the accessible name, the icon points to
    // the corners when collapsed and inward when stretched.
    const expand = liveButtons(fixture).find((button) => button.props.label === "Expand")!;
    assert.ok(expand, "the bar carries an expand control");
    assert.equal(expand.props.iconOnly, true, "the expand control is an icon-only button");
    assert.match(String(expand.props.icon ?? ""), /M8 3H5/, "the expand icon points to the corners");
    assert.equal(pane.style.top, "12px", "the floating window pins under the header");
    await expand.props.onClick();
    assert.ok(pane.classList.contains("lp-inspector-expanded"), "expanding widens the window");
    assert.equal(
      pane.style.top,
      "12px",
      "the expanded window keeps the same measured pin — just below the header, flush at the viewport margin once the page scrolls past it — so its bar never tucks under the header (zero rects here pin the margin)",
    );
    const restore = liveButtons(fixture).find((button) => button.props.label === "Restore")!;
    assert.ok(restore, "the expand control becomes a restore control");
    assert.match(String(restore.props.icon ?? ""), /M8 3v3/, "the restore icon points inward");
    await restore.props.onClick();
    assert.ok(!pane.classList.contains("lp-inspector-expanded"), "restoring returns to the half");
    assert.equal(pane.style.top, "12px", "restoring brings the measured pin back");

    // Close is an X, and still deselects with the new bar layout.
    const close = liveButtons(fixture).find((button) => button.props.label === "Close")!;
    assert.equal(close.props.iconOnly, true, "the close control is an icon-only button");
    assert.match(String(close.props.icon ?? ""), /M18 6 6 18/, "the close icon is an X");
    await close.props.onClick();
    await fixture.flush();
    assert.equal(pane.hidden, true, "close keeps working from the auto-hiding bar");
  } finally {
    fixture.restore();
  }
});

test("dragging the bar moves the window vertically and horizontally; double-click resets", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    await mounted(fixture);
    const pane = fixture.root.querySelector<HTMLElement>(".lp-inspector-pane")!;
    const bar = pane.querySelector<HTMLElement>(".lp-inspector-bar")!;
    // Zero rects in the test host pin the window at the viewport margin; the
    // horizontal offset rides the same mechanism (left is only set from a
    // measured hub rect, which this host does not provide).
    assert.equal(pane.style.top, "12px");

    const doc = fixture.root.ownerDocument;
    // Drag down 100, then back up 40 within the same press.
    bar.dispatchEvent(pointerEvent(doc, "pointerdown", { pointerId: 7, clientX: 300, clientY: 20, button: 0 }));
    bar.dispatchEvent(pointerEvent(doc, "pointermove", { pointerId: 7, clientX: 300, clientY: 120 }));
    assert.equal(pane.style.top, "112px", "the window follows the drag downward");
    bar.dispatchEvent(pointerEvent(doc, "pointermove", { pointerId: 7, clientX: 250, clientY: 60 }));
    assert.equal(pane.style.top, "52px", "the offset rides along, up and down");
    bar.dispatchEvent(pointerEvent(doc, "pointerup", { pointerId: 7 }));

    // The dragged offset survives a background refresh.
    fixture.emit("paths-changed", { id: path.id });
    await fixture.flush();
    assert.equal(pane.style.top, "52px", "refreshes keep the dragged position");

    // Never above the viewport margin, however far up the pointer goes.
    bar.dispatchEvent(pointerEvent(doc, "pointerdown", { pointerId: 8, clientX: 300, clientY: 40, button: 0 }));
    bar.dispatchEvent(pointerEvent(doc, "pointermove", { pointerId: 8, clientX: 300, clientY: -600 }));
    assert.equal(pane.style.top, "12px", "the window never leaves the viewport");
    bar.dispatchEvent(pointerEvent(doc, "pointerup", { pointerId: 8 }));

    // A double-click on the bar puts the window back where it pins.
    bar.dispatchEvent(pointerEvent(doc, "pointerdown", { pointerId: 9, clientX: 300, clientY: 20, button: 0 }));
    bar.dispatchEvent(pointerEvent(doc, "pointermove", { pointerId: 9, clientX: 300, clientY: 120 }));
    bar.dispatchEvent(pointerEvent(doc, "pointerup", { pointerId: 9 }));
    assert.equal(pane.style.top, "112px");
    fire(bar, "dblclick");
    assert.equal(pane.style.top, "12px", "a double-click resets the pinned default");

    // A press on a tab is the tab's own, never a window move.
    const tab = bar.querySelector<HTMLElement>(".lp-tab")!;
    tab.dispatchEvent(pointerEvent(doc, "pointerdown", { pointerId: 10, clientX: 30, clientY: 20, button: 0 }));
    tab.dispatchEvent(pointerEvent(doc, "pointermove", { pointerId: 10, clientX: 30, clientY: 220 }));
    assert.equal(pane.style.top, "12px", "the tab's own press is not a window move");
    tab.dispatchEvent(pointerEvent(doc, "pointerup", { pointerId: 10 }));
  } finally {
    fixture.restore();
  }
});

test("the floating window stays below the host's standing view header while the view scrolls", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    // The real host keeps its view header ("Learning Paths") standing above
    // the plugin's own scrolling region: a static top bar beside a scroll
    // container, so scrolling the region never moves the header. This test
    // host has no layout engine, so the chrome is stubbed to that shape.
    const doc = fixture.root.ownerDocument;
    const topBar = doc.createElement("header");
    topBar.textContent = "Learning Paths";
    const scrollRegion = doc.createElement("div");
    topBar.getBoundingClientRect = () =>
      ({ top: 0, bottom: 60, left: 0, right: 1024, width: 1024, height: 60, x: 0, y: 0, toJSON() {} }) as DOMRect;
    scrollRegion.getBoundingClientRect = () =>
      ({ top: 60, bottom: 800, left: 0, right: 1024, width: 1024, height: 740, x: 0, y: 60, toJSON() {} }) as DOMRect;
    Object.defineProperty(scrollRegion, "scrollHeight", { value: 4000 });
    Object.defineProperty(scrollRegion, "clientHeight", { value: 740 });
    doc.body.insertBefore(topBar, fixture.root);
    doc.body.insertBefore(scrollRegion, fixture.root);
    scrollRegion.append(fixture.root);
    const view = doc.defaultView as unknown as {
      getComputedStyle?: (candidate: Element) => { position: string; overflowY: string };
    };
    view.getComputedStyle = (candidate: Element) => ({
      position: "static",
      overflowY: candidate === (scrollRegion as Element) ? "auto" : "visible",
    });

    await mounted(fixture);
    await selectRoadmapCard(fixture.root, "n-skill");
    const pane = fixture.root.querySelector<HTMLElement>(".lp-inspector-pane")!;
    assert.equal(pane.style.top, "72px", "the pin clears the standing header (60 + 12 breathing room)");

    // Scrolling the plugin's own region re-pins under the header instead of
    // jumping to the viewport top, in both window shapes.
    fire(scrollRegion, "scroll");
    assert.equal(pane.style.top, "72px", "scrolling keeps the window under the standing header");
    const expand = liveButtons(fixture).find((button) => button.props.label === "Expand")!;
    await expand.props.onClick();
    assert.equal(pane.style.top, "72px", "the expanded window clears the standing header too");
    const restore = liveButtons(fixture).find((button) => button.props.label === "Restore")!;
    await restore.props.onClick();

    // Dragging up cannot tuck the window under the header either.
    const bar = pane.querySelector<HTMLElement>(".lp-inspector-bar")!;
    bar.dispatchEvent(pointerEvent(doc, "pointerdown", { pointerId: 11, clientX: 300, clientY: 80, button: 0 }));
    bar.dispatchEvent(pointerEvent(doc, "pointermove", { pointerId: 11, clientX: 300, clientY: -400 }));
    assert.equal(pane.style.top, "72px", "a drag never lifts the window above the header pin");
    bar.dispatchEvent(pointerEvent(doc, "pointerup", { pointerId: 11 }));
  } finally {
    fixture.restore();
  }
});

test("the floating window stays below host chrome that is stuck over the scrolling content", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    await mounted(fixture);

    // Other hosts pin their header over the content with position: sticky.
    // The chrome is stubbed: a sticky header element above the plugin's
    // container with a measured-looking rect, and a getComputedStyle that
    // reports its position.
    const doc = fixture.root.ownerDocument;
    const hostHeader = doc.createElement("header");
    hostHeader.className = "host-view-header";
    hostHeader.textContent = "Learning Paths";
    hostHeader.getBoundingClientRect = () =>
      ({ top: 0, bottom: 56, left: 0, right: 1024, width: 1024, height: 56, x: 0, y: 0, toJSON() {} }) as DOMRect;
    doc.body.insertBefore(hostHeader, fixture.root);
    const view = doc.defaultView as unknown as {
      getComputedStyle?: (candidate: Element) => { position: string; overflowY: string };
    };
    view.getComputedStyle = (candidate: Element) => ({
      position: candidate === (hostHeader as Element) ? "sticky" : "static",
      overflowY: "visible",
    });

    await selectRoadmapCard(fixture.root, "n-skill");
    const pane = fixture.root.querySelector<HTMLElement>(".lp-inspector-pane")!;
    assert.equal(pane.style.top, "68px", "the pin clears the stuck host header (56 + 12 breathing room)");

    fire(fixture.root, "scroll");
    assert.equal(pane.style.top, "68px", "scrolling keeps the window under the stuck header");
  } finally {
    fixture.restore();
  }
});

test("an empty hub offers Create a Path and does not invent a roadmap or inspector node", async () => {
  const fixture = createViewFixture();
  try {
    await mounted(fixture);
    assert.equal(fixture.root.querySelector<HTMLElement>(".lp-architect-pane")!.hidden, false);
    assert.match(fixture.root.textContent ?? "", /No learning paths yet/);
    assert.match(fixture.root.querySelector<HTMLElement>(".lp-inspector")!.textContent ?? "", /Select a node/);
    assert.equal(
      fixture.root.querySelectorAll(".lp-roadmap-card").length,
      0,
      "no empty roadmap is drawn without a path",
    );
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

test("Path Hub exports the selected path as JSON and Markdown from its menu", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const exported: { format: string; filename: string; content: string }[] = [];
    mountPathHub(fixture.context, fixture.root, fixture.context.signal, {
      onExport(item) {
        exported.push(item);
      },
    });
    await fixture.flush();

    const exportButton = () =>
      fixture.findLast("mountButton", (record) => record.props.label === "Export Path");
    assert.equal(exportButton().props.disabled, false);
    await exportButton().props.onClick();
    const jsonMenu = fixture.findLast("openMenu");
    assert.equal(jsonMenu.props.label, "Export learning path");
    assert.equal(jsonMenu.props.preferredSide, "down");
    assert.deepEqual(
      jsonMenu.props.items.map((item: { key: string }) => item.key),
      ["export-json", "export-markdown"],
    );
    await jsonMenu.props.items.find((item: { key: string }) => item.key === "export-json").onSelect();
    await fixture.flush();

    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.export").at(-1)?.input, {
      pathId: path.id,
      format: "json",
    });
    assert.equal(exported.length, 1);
    assert.equal(exported[0]!.format, "json");
    assert.equal(exported[0]!.filename, "linear-algebra-from-canon.json");
    assert.equal(JSON.parse(exported[0]!.content).id, path.id);

    await exportButton().props.onClick();
    const markdownMenu = fixture.findLast("openMenu");
    await markdownMenu.props.items
      .find((item: { key: string }) => item.key === "export-markdown")
      .onSelect();
    await fixture.flush();

    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.export").at(-1)?.input, {
      pathId: path.id,
      format: "markdown",
    });
    assert.equal(exported.length, 2);
    assert.equal(exported[1]!.format, "markdown");
    assert.equal(exported[1]!.filename, "linear-algebra-from-canon.md");
    assert.match(exported[1]!.content, /^# Linear algebra from canon/);
  } finally {
    fixture.restore();
  }
});

test("Path Hub disables Export Path when there is no selected path", async () => {
  const fixture = createViewFixture();
  try {
    mountPathHub(fixture.context, fixture.root, fixture.context.signal);
    await fixture.flush();
    const exportButton = fixture.find("mountButton", (record) => record.props.label === "Export Path");
    assert.equal(exportButton.props.disabled, true);
    await exportButton.props.onClick();
    assert.equal(fixture.all("openMenu").length, 0);
  } finally {
    fixture.restore();
  }
});

test("Add to workspace converts the document and files it linked grounds to the node in view", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    await mounted(fixture);
    const button = liveButtons(fixture).find((record) => record.props.label === "Add to workspace");
    assert.ok(button, "the Architect surface carries the workspace upload affordance");

    await button!.props.onClick();
    const input = fixture.root.querySelector<HTMLInputElement>('input[type="file"]')!;
    assert.ok(input, "the affordance opens the shared native file picker");
    fixture.toMarkdown = async () => ({
      name: "paper.md",
      markdown: "# Paper\n\nConverted text.",
      notices: ["One image-only page was skipped."],
    });
    const file = new File(["# Paper"], "paper.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { configurable: true, value: { item: () => file } });
    fire(input, "change");
    await fixture.flush();
    await fixture.flush();

    const dialog = fixture.all("openDialog").at(-1)!;
    assert.match(String(dialog.props.title), /paper\.md/, "the filing dialog names the document");
    assert.match(
      fixture.root.textContent ?? "",
      /One image-only page was skipped/,
      "conversion notices surface in the dialog, as the sources flow surfaces them",
    );
    const save = liveButtons(fixture).find((record) => record.props.label === "Save to Workspace");
    assert.ok(save);
    assert.equal(save!.props.disabled, undefined, "conversion enables the save");
    assert.equal(fixture.uploaded.length, 0, "no library write before the learner confirms");

    await save!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const call = fixture.calls.filter((entry) => entry.name === "workspace.saveSource").at(-1);
    assert.deepEqual(call?.input, {
      pathId: "path-linear-algebra",
      name: "paper.md",
      markdown: "# Paper\n\nConverted text.",
      links: [{ to: "n-holistic", rel: "grounds" }],
    }, "the node in view is the default grounds link; one learner write files everything");
    assert.equal(fixture.uploaded.length, 1, "the document lives once, in the global library");

    const status = () => fixture.root.querySelector<HTMLElement>(".lp-upload-status")!;
    assert.match(status().textContent ?? "", /Filed paper\.md in the workspace/);
    assert.match(status().textContent ?? "", /One image-only page was skipped/);
    assert.equal(status().dataset.state, "success");
  } finally {
    fixture.restore();
  }
});

test("Add to workspace without a selected path declines in the status line", async () => {
  const fixture = createViewFixture({});
  try {
    await mounted(fixture);
    const button = liveButtons(fixture).find((record) => record.props.label === "Add to workspace");
    assert.ok(button, "the affordance stays available so it can explain itself");
    await button!.props.onClick();
    const input = fixture.root.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(["# Paper"], "paper.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { configurable: true, value: { item: () => file } });
    fire(input, "change");
    await fixture.flush();

    const status = () => fixture.root.querySelector<HTMLElement>(".lp-upload-status")!;
    assert.match(status().textContent ?? "", /Select a path first/);
    assert.equal(status().dataset.state, "error");
    assert.equal(fixture.calls.filter((entry) => entry.name === "workspace.saveSource").length, 0);
    assert.equal(fixture.uploaded.length, 0, "declining writes nothing");
  } finally {
    fixture.restore();
  }
});
