/** Paths overview tests.
 *
 * Mounted through the real Path Hub against the recorded host UI and the
 * in-memory backend: cards render honest inventory, the tag filter groups
 * client-side, tag edits save through `paths.updateMeta` and refetch, and the
 * whole surface disposes with the hub. No browser or model request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountPathHub } from "../src/view/path-hub.ts";
import type { LearningPath } from "../src/domain.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture, fire, makeConversation, setSelect } from "./view-host.ts";

function snapshot(id: string) {
  return makeConversation(id);
}

function makeTaggedPath(id: string, tags: readonly string[]): LearningPath {
  const path = makePath();
  return {
    ...path,
    id,
    title: `Path ${id}`,
    goal: `Goal for ${id}.`,
    ...(tags.length === 0 ? {} : { tags }),
  };
}

function makeFiledPath(id: string, folder: string, tags: readonly string[] = []): LearningPath {
  return { ...makeTaggedPath(id, tags), folder };
}

async function mounted(fixture: ReturnType<typeof createViewFixture>): Promise<HTMLElement> {
  const container = fixture.root;
  fixture.context.signal.addEventListener("abort", () => container.replaceChildren());
  mountPathHub(fixture.context, container, fixture.context.signal);
  await fixture.flush();
  return container;
}

function overviewCards(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(".lp-path-card")];
}

function visibleIds(root: HTMLElement): (string | null)[] {
  return overviewCards(root).map((card) => card.getAttribute("data-path-id"));
}

function countText(root: HTMLElement): string {
  return root.querySelector<HTMLElement>(".lp-overview-count")?.textContent ?? "";
}

/** The results region's empty state, never the hub's "No learning paths yet". */
function resultsEmptyState(root: HTMLElement): HTMLElement | null {
  return root.querySelector<HTMLElement>(".lp-overview-cards .lp-empty-state");
}

function typeSearch(root: HTMLElement, value: string): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>(".lp-search-input");
  assert.ok(input, "the Paths overview renders a search box when paths exist");
  input.value = value;
  fire(input, "input");
  return input;
}

function cardButton(fixture: ReturnType<typeof createViewFixture>, pathId: string, label: string) {
  const card = fixture.root.querySelector<HTMLElement>(`.lp-path-card[data-path-id="${pathId}"]`);
  assert.ok(card, `Missing card for ${pathId}`);
  assert.ok(!card.hidden);
  const record = fixture
    .all("mountButton")
    .find((entry) => card.contains(entry.container) && entry.props.label === label);
  assert.ok(record, `Missing ${label} button on the card for ${pathId}`);
  return record;
}

test("the overview renders one honest-inventory card per path and none when empty", async () => {
  const fixture = createViewFixture({
    paths: [makePath(), makeTaggedPath("path-two", ["field:systems"])],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const pane = fixture.root.querySelector<HTMLElement>(".lp-overview-pane")!;
    assert.equal(pane.hidden, false);

    const cards = overviewCards(fixture.root);
    assert.equal(cards.length, 2);
    const first = cards.find((card) => card.getAttribute("data-path-id") === "path-linear-algebra")!;
    assert.match(first.textContent ?? "", /2 modules · 6 nodes/);
    assert.match(first.textContent ?? "", /Canonical · OSTEP/);
    assert.match(first.textContent ?? "", /1 consolidated · 2 in progress · 3 unstarted/);
    const cardBadges = (card: HTMLElement) =>
      fixture.all("mountBadge").filter((record) => card.contains(record.container));
    assert.ok(
      cardBadges(first).some((record) => record.props.text === "1 pending pivot"),
      "a pending pivot surfaces as an honest count badge",
    );
    assert.ok(
      cardBadges(first).some((record) => record.props.text === "1 unresolved error"),
      "unresolved watchpoints surface the same way",
    );
    const second = cards.find((card) => card.getAttribute("data-path-id") === "path-two")!;
    assert.match(second.textContent ?? "", /field:systems/);
    assert.doesNotMatch(pane.textContent ?? "", /%|streak|day|hour|due/i);
    assert.ok(
      fixture.root.querySelectorAll(".lp-distribution-segment").length === 6,
      "each card draws a three-segment distribution strip",
    );
    const strip = first.querySelector(".lp-distribution")!;
    assert.equal(strip.getAttribute("aria-label"), "1 consolidated · 2 in progress · 3 unstarted");

    // Filing lives at the card's foot: the Edit tags affordance is the card's
    // last row, an icon-only tag glyph whose label stays the accessible name.
    const footer = first.querySelector<HTMLElement>(".lp-path-card-footer")!;
    assert.ok(footer, "the card carries a footer row");
    assert.equal(footer, first.lastElementChild, "the footer sits at the very bottom of the card");
    const edit = cardButton(fixture, "path-linear-algebra", "Edit tags");
    assert.ok(footer.contains(edit.container), "the footer hosts the filing affordance");
    assert.equal(edit.props.iconOnly, true, "Edit tags reads as a glyph, not words");
    assert.match(String(edit.props.icon ?? ""), /<svg/, "the glyph is the tag icon");
    assert.match(String(edit.props.title ?? ""), /Edit tags — Linear algebra/, "hover carries the words");
  } finally {
    fixture.restore();
  }
});

test("an empty hub keeps a single empty state and hides the overview", async () => {
  const fixture = createViewFixture();
  try {
    await mounted(fixture);
    const pane = fixture.root.querySelector<HTMLElement>(".lp-overview-pane")!;
    assert.equal(pane.hidden, true, "no dashboard over zero paths");
    assert.match(fixture.root.textContent ?? "", /No learning paths yet/);
    assert.equal(overviewCards(fixture.root).length, 0);
    assert.equal(
      fixture.root.querySelector(".lp-search-input"),
      null,
      "no search box without paths to search",
    );
  } finally {
    fixture.restore();
  }
});

test("a card click selects that path, like the header select", async () => {
  const fixture = createViewFixture({
    paths: [makePath(), makeTaggedPath("path-two", [])],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const before = fixture.calls.filter((call) => call.name === "paths.get").length;
    await cardButton(fixture, "path-two", "Path path-two").props.onClick();
    await fixture.flush();

    assert.deepEqual(
      fixture.calls.filter((call) => call.name === "paths.get").at(-1)?.input,
      { id: "path-two" },
    );
    const select = fixture.root.querySelector<HTMLSelectElement>(".lp-path-select")!;
    const chosen = [...select.options].find((option) => option.selected);
    assert.equal(chosen?.value, "path-two");
    assert.match(fixture.root.querySelector<HTMLElement>(".lp-goal")!.textContent ?? "", /Goal for path-two/);
    assert.ok(before >= 1, "the overview never bypasses the authoritative refetch");
    const selected = overviewCards(fixture.root).find((card) => card.classList.contains("lp-path-card-selected"));
    assert.equal(selected?.dataset.pathId, "path-two");
  } finally {
    fixture.restore();
  }
});

test("clicking anywhere on a card selects the path; a card's buttons keep their own action", async () => {
  const fixture = createViewFixture({
    paths: [makePath(), makeTaggedPath("path-two", [])],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const card = fixture.root.querySelector<HTMLElement>('.lp-path-card[data-path-id="path-two"]')!;
    fire(card, "click");
    await fixture.flush();

    assert.deepEqual(
      fixture.calls.filter((call) => call.name === "paths.get").at(-1)?.input,
      { id: "path-two" },
    );
    assert.match(fixture.root.querySelector<HTMLElement>(".lp-goal")!.textContent ?? "", /Goal for path-two/);
    const selected = fixture.root.querySelector<HTMLElement>(".lp-path-card-selected");
    assert.equal(selected?.getAttribute("data-path-id"), "path-two");

    // A click that lands inside a card's own button host is that button's
    // action, never an accidental path switch.
    const callsBefore = fixture.calls.filter((call) => call.name === "paths.get").length;
    fire(card.querySelector<HTMLElement>(".lp-button-host")!, "click");
    await fixture.flush();
    assert.equal(
      fixture.calls.filter((call) => call.name === "paths.get").length,
      callsBefore,
    );
  } finally {
    fixture.restore();
  }
});

test("the tag filter groups cards client-side without refetching", async () => {
  const fixture = createViewFixture({
    paths: [
      makeTaggedPath("path-exam", ["exam:step-2"]),
      makeTaggedPath("path-field", ["field:systems"]),
      makeTaggedPath("path-plain", []),
    ],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const filter = fixture.root.querySelector<HTMLSelectElement>(".lp-overview-filter")!;
    assert.ok(filter, "the group filter mounts when any path has tags");
    assert.deepEqual(
      [...filter.options].map((option) => option.value),
      ["", "exam:step-2", "field:systems"],
    );

    const listCallsBefore = fixture.calls.filter((call) => call.name === "paths.list").length;
    setSelect(filter, "exam:step-2");
    let visible = overviewCards(fixture.root).map((card) => card.getAttribute("data-path-id"));
    assert.deepEqual(visible, ["path-exam"]);
    assert.equal(
      fixture.calls.filter((call) => call.name === "paths.list").length,
      listCallsBefore,
      "grouping is a client-side filter, not another fetch",
    );

    setSelect(filter, "field:systems");
    visible = overviewCards(fixture.root).map((card) => card.getAttribute("data-path-id"));
    assert.deepEqual(visible, ["path-field"]);

    setSelect(filter, "");
    visible = overviewCards(fixture.root).map((card) => card.getAttribute("data-path-id"));
    assert.deepEqual(visible.sort(), ["path-exam", "path-field", "path-plain"]);
  } finally {
    fixture.restore();
  }
});

test("the search box narrows cards by title, goal and tag, case-insensitively", async () => {
  const fixture = createViewFixture({
    paths: [
      makePath(),
      makeTaggedPath("path-exam", ["exam:step-2"]),
      makeTaggedPath("path-field", ["field:systems"]),
    ],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const input = fixture.root.querySelector<HTMLInputElement>(".lp-search-input");
    assert.ok(input, "the search box mounts whenever paths exist");
    assert.equal(input.getAttribute("aria-label"), "Search paths");
    assert.equal(countText(fixture.root), "3 of 3 paths");

    const listCallsBefore = fixture.calls.filter((call) => call.name === "paths.list").length;

    typeSearch(fixture.root, "LINEAR");
    assert.deepEqual(visibleIds(fixture.root), ["path-linear-algebra"], "a title substring narrows");
    assert.equal(countText(fixture.root), "1 of 3 paths");

    typeSearch(fixture.root, "durable LINEAR-ALGEBRA");
    assert.deepEqual(
      visibleIds(fixture.root),
      ["path-linear-algebra"],
      "goal text matches without regard to case",
    );

    typeSearch(fixture.root, "STEP-2");
    assert.deepEqual(visibleIds(fixture.root), ["path-exam"], "tags match without regard to case");

    typeSearch(fixture.root, "field:SYSTEMS");
    assert.deepEqual(visibleIds(fixture.root), ["path-field"]);

    assert.equal(
      fixture.calls.filter((call) => call.name === "paths.list").length,
      listCallsBefore,
      "searching is a client-side filter, not another fetch",
    );

    typeSearch(fixture.root, "no-such-path");
    assert.deepEqual(visibleIds(fixture.root), [], "never an empty grid");
    assert.equal(countText(fixture.root), "0 of 3 paths", "the count stays honest at zero");
    const empty = resultsEmptyState(fixture.root);
    assert.ok(empty, "an empty result names its state instead of an empty grid");
    assert.match(empty.textContent ?? "", /No paths match/);
    assert.match(empty.textContent ?? "", /no-such-path/, "the empty state names the search term");
    assert.match(empty.textContent ?? "", /Clear the search/);

    typeSearch(fixture.root, "");
    assert.deepEqual(visibleIds(fixture.root).sort(), [
      "path-exam",
      "path-field",
      "path-linear-algebra",
    ]);
    assert.equal(countText(fixture.root), "3 of 3 paths");
    // Compare with === : assert.equal on a linkedom node hangs formatting the diff.
    assert.ok(resultsEmptyState(fixture.root) === null, "clearing the search removes the empty state");
  } finally {
    fixture.restore();
  }
});

test("search composes with a held tag filter under AND semantics", async () => {
  const fixture = createViewFixture({
    paths: [
      makeTaggedPath("path-exam", ["exam:step-2"]),
      makeTaggedPath("path-field", ["field:systems"]),
      makeTaggedPath("path-plain", []),
    ],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const filter = fixture.root.querySelector<HTMLSelectElement>(".lp-overview-filter")!;
    setSelect(filter, "exam:step-2");
    assert.deepEqual(visibleIds(fixture.root), ["path-exam"]);
    assert.equal(countText(fixture.root), "1 of 3 paths");

    typeSearch(fixture.root, "field");
    assert.deepEqual(
      visibleIds(fixture.root),
      [],
      "a search hit outside the held tag group does not leak through",
    );
    assert.equal(countText(fixture.root), "0 of 3 paths");
    const empty = resultsEmptyState(fixture.root);
    assert.ok(empty, "the composed filter shows an empty state, not an empty grid");
    assert.match(empty.textContent ?? "", /No paths match/);
    assert.match(empty.textContent ?? "", /field/, "the empty state names the search term");
    assert.match(
      empty.textContent ?? "",
      /Clear the search and the group filter/,
      "the empty state says how to get back to every path",
    );

    typeSearch(fixture.root, "exam");
    assert.deepEqual(
      visibleIds(fixture.root),
      ["path-exam"],
      "only the intersection of search and tag group shows",
    );
    assert.equal(countText(fixture.root), "1 of 3 paths");

    typeSearch(fixture.root, "");
    assert.deepEqual(visibleIds(fixture.root), ["path-exam"], "clearing the search keeps the held filter");
    assert.equal(countText(fixture.root), "1 of 3 paths");

    setSelect(filter, "");
    assert.deepEqual(visibleIds(fixture.root).sort(), ["path-exam", "path-field", "path-plain"]);
    assert.equal(countText(fixture.root), "3 of 3 paths");
  } finally {
    fixture.restore();
  }
});

test("the search text survives a refetch and keeps narrowing", async () => {
  const fixture = createViewFixture({
    paths: [
      makeTaggedPath("path-exam", ["exam:step-2"]),
      makeTaggedPath("path-field", ["field:systems"]),
    ],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    typeSearch(fixture.root, "exam");
    assert.deepEqual(visibleIds(fixture.root), ["path-exam"]);

    fixture.emit("paths-changed", { id: "path-exam" });
    await fixture.flush();
    const input = fixture.root.querySelector<HTMLInputElement>(".lp-search-input")!;
    assert.equal(input.value, "exam", "a refetch re-renders the box with the held query");
    assert.deepEqual(visibleIds(fixture.root), ["path-exam"]);
    assert.equal(countText(fixture.root), "1 of 2 paths");
  } finally {
    fixture.restore();
  }
});

test("filtering by a tag no path carries says so instead of an empty grid", async () => {
  const fixture = createViewFixture({
    paths: [makeTaggedPath("path-a", ["exam:step-2"])],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const filter = fixture.root.querySelector<HTMLSelectElement>(".lp-overview-filter")!;
    setSelect(filter, "exam:step-2");
    // Simulate the tag disappearing from every path while the filter is held.
    const { tags: _tags, ...withoutTags } = fixture.paths.get("path-a")!;
    fixture.paths.set("path-a", withoutTags);
    fixture.emit("paths-changed", { id: "path-a" });
    await fixture.flush();
    assert.match(fixture.root.textContent ?? "", /No paths carry this tag/);
    assert.ok(fixture.root.querySelector<HTMLSelectElement>(".lp-overview-filter"));
  } finally {
    fixture.restore();
  }
});

test("Edit tags saves through paths.updateMeta, refetches and renders the new filing", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const edit = cardButton(fixture, "path-linear-algebra", "Edit tags");
    await edit.props.onClick();
    await fixture.flush();

    const dialog = fixture.find("openDialog");
    assert.equal(dialog.props.title, "Edit tags — Linear algebra from canon");
    const input = dialog.contentContainer!.querySelector<HTMLInputElement>(".lp-tags-input")!;
    assert.equal(input.value, "");
    input.value = "exam:step-2, field:systems";
    const save = fixture
      .all("mountButton")
      .find((record) => dialog.contentContainer!.contains(record.container) && record.props.label === "Save tags")!;
    await save.props.onClick();
    await fixture.flush();
    await fixture.flush();

    assert.deepEqual(
      fixture.calls.filter((call) => call.name === "paths.updateMeta").at(-1)?.input,
      { pathId: "path-linear-algebra", tags: ["exam:step-2", "field:systems"] },
    );
    assert.deepEqual(fixture.paths.get("path-linear-algebra")!.tags, ["exam:step-2", "field:systems"]);
    const card = fixture.root.querySelector<HTMLElement>('.lp-path-card[data-path-id="path-linear-algebra"]')!;
    assert.match(card.textContent ?? "", /exam:step-2/);
    assert.equal(dialog.disposed >= 1, true, "a successful save closes the dialog");
  } finally {
    fixture.restore();
  }
});

test("Delete path removes the path through paths.delete and refetches the overview", async () => {
  const fixture = createViewFixture({
    paths: [makePath(), makeTaggedPath("path-two", ["field:systems"])],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const listCallsBefore = fixture.calls.filter((call) => call.name === "paths.list").length;

    await cardButton(fixture, "path-linear-algebra", "Delete path").props.onClick();
    await fixture.flush();
    const dialog = fixture.findLast("openDialog");
    assert.equal(dialog.props.title, "Delete the learning path \"Linear algebra from canon\"?");
    assert.match(
      dialog.contentContainer!.textContent ?? "",
      /Native LearnHarness chats and Knowledge Graph records are never deleted/,
      "the dialog says what stays",
    );

    // Keep path closes without a write.
    const keep = fixture
      .all("mountButton")
      .find((record) => dialog.contentContainer!.contains(record.container) && record.props.label === "Keep path")!;
    await keep.props.onClick();
    await fixture.flush();
    assert.equal(dialog.disposed >= 1, true, "Keep path dismisses the dialog");
    assert.equal(fixture.calls.some((call) => call.name === "paths.delete"), false, "nothing was deleted");
    assert.equal(
      fixture.calls.filter((call) => call.name === "paths.list").length,
      listCallsBefore,
      "no refetch for a kept path",
    );

    // Delete path is the settings page's same one write, then the hub refetches.
    await cardButton(fixture, "path-linear-algebra", "Delete path").props.onClick();
    await fixture.flush();
    const confirmDialog = fixture.findLast("openDialog");
    const remove = fixture
      .all("mountButton")
      .find((record) => confirmDialog.contentContainer!.contains(record.container) && record.props.label === "Delete path")!;
    await remove.props.onClick();
    await fixture.flush();
    await fixture.flush();

    assert.deepEqual(
      fixture.calls.filter((call) => call.name === "paths.delete").at(-1)?.input,
      { pathId: "path-linear-algebra" },
      "the affordance goes through the backend RPC",
    );
    assert.equal(fixture.paths.has("path-linear-algebra"), false, "the path record is gone");
    assert.ok(
      fixture.calls.filter((call) => call.name === "paths.list").length > listCallsBefore,
      "the hub refetches after the delete",
    );
    assert.ok(!visibleIds(fixture.root).includes("path-linear-algebra"), "the card is gone after the refetch");
    assert.ok(visibleIds(fixture.root).includes("path-two"), "the other path stays");
  } finally {
    fixture.restore();
  }
});

test("Edit tags shows precise inline errors and never saves invalid filing", async () => {
  const fixture = createViewFixture({
    paths: [makeTaggedPath("path-one", ["field:systems"])],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    await cardButton(fixture, "path-one", "Edit tags").props.onClick();
    await fixture.flush();

    const dialog = fixture.find("openDialog");
    const input = dialog.contentContainer!.querySelector<HTMLInputElement>(".lp-tags-input")!;
    assert.equal(input.value, "field:systems");

    const save = () =>
      fixture
        .all("mountButton")
        .find((record) => dialog.contentContainer!.contains(record.container) && record.props.label === "Save tags")!;

    input.value = "field:systems, Field:Systems";
    await save().props.onClick();
    await fixture.flush();
    assert.match(
      dialog.contentContainer!.querySelector<HTMLElement>(".lp-dialog-error")!.textContent ?? "",
      /Duplicate tag/i,
    );

    input.value = `${"x".repeat(41)}`;
    await save().props.onClick();
    await fixture.flush();
    assert.match(
      dialog.contentContainer!.querySelector<HTMLElement>(".lp-dialog-error")!.textContent ?? "",
      /at most 40 characters/i,
    );

    assert.equal(
      fixture.calls.filter((call) => call.name === "paths.updateMeta").length,
      0,
      "invalid input never reaches the backend",
    );
    assert.equal(dialog.disposed, 0, "the dialog stays open for a correction");
    assert.deepEqual(fixture.paths.get("path-one")!.tags, ["field:systems"], "the record is untouched");
  } finally {
    fixture.restore();
  }
});

test("the folder picker shows one hierarchy with subtree counts and filters cards", async () => {
  const fixture = createViewFixture({
    paths: [
      makeFiledPath("path-exam-a", "exam/step-2", ["math"]),
      makeFiledPath("path-exam-b", "exam/step-2", ["physics"]),
      makeFiledPath("path-field", "field/systems", ["math"]),
      makeTaggedPath("path-plain", []),
    ],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const picker = () => fixture.root.querySelector<HTMLSelectElement>(".lp-overview-folder")!;
    const select = picker();
    assert.ok(select, "the folder picker always renders");
    const values = [...select.options].map((option) => option.value);
    const unfiled = values.find((value) => value.startsWith("\u0000"))!;
    assert.deepEqual(
      values.filter((value) => value !== "" && value !== unfiled),
      ["exam", "exam/step-2", "field", "field/systems"],
      "nested folders list as one depth-first hierarchy",
    );
    const labelFor = (needle: string) =>
      [...select.options].find((option) => (option.textContent ?? "").includes(needle))!;
    assert.match(labelFor("All paths").textContent ?? "", /All paths \(4\)/);
    assert.match(labelFor("Unfiled").textContent ?? "", /Unfiled \(1\)/);
    assert.match(labelFor("exam").textContent ?? "", /exam \(2\)/);
    assert.match(labelFor("step-2").textContent ?? "", /step-2 \(2\)/);
    assert.match(labelFor("systems").textContent ?? "", /systems \(1\)/);

    const cardIds = () => overviewCards(fixture.root).map((card) => card.dataset.pathId).sort();
    assert.match(
      fixture.root.querySelector<HTMLElement>('.lp-path-card[data-path-id="path-exam-a"]')!.textContent ?? "",
      /Folder: exam\/step-2/,
      "a card shows where it is filed",
    );

    const before = fixture.calls.filter((call) => call.name === "paths.list").length;
    setSelect(picker(), "exam");
    assert.deepEqual(cardIds(), ["path-exam-a", "path-exam-b"], "a parent folder includes its subtree");
    setSelect(picker(), "exam/step-2");
    assert.deepEqual(cardIds(), ["path-exam-a", "path-exam-b"]);
    setSelect(picker(), "field");
    assert.deepEqual(cardIds(), ["path-field"]);
    setSelect(picker(), unfiled);
    assert.deepEqual(cardIds(), ["path-plain"], "unfiled paths stay reachable under Unfiled");
    setSelect(picker(), "");
    assert.deepEqual(cardIds(), ["path-exam-a", "path-exam-b", "path-field", "path-plain"]);
    assert.equal(
      fixture.calls.filter((call) => call.name === "paths.list").length,
      before,
      "folder filtering is client-side, not another fetch",
    );
  } finally {
    fixture.restore();
  }
});

test("the folder filter composes with the tag group filter", async () => {
  const fixture = createViewFixture({
    paths: [
      makeFiledPath("path-exam-math", "exam/step-2", ["math"]),
      makeFiledPath("path-exam-physics", "exam/step-2", ["physics"]),
      makeFiledPath("path-field-math", "field/systems", ["math"]),
    ],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const picker = () => fixture.root.querySelector<HTMLSelectElement>(".lp-overview-folder")!;
    const tagPicker = () => fixture.root.querySelector<HTMLSelectElement>(".lp-overview-filter")!;
    setSelect(picker(), "exam");
    setSelect(tagPicker(), "math");
    assert.deepEqual(
      overviewCards(fixture.root).map((card) => card.dataset.pathId),
      ["path-exam-math"],
      "cards must satisfy both the folder and the tag filter",
    );
    setSelect(tagPicker(), "physics");
    assert.deepEqual(overviewCards(fixture.root).map((card) => card.dataset.pathId), ["path-exam-physics"]);
    setSelect(picker(), "field");
    assert.equal(overviewCards(fixture.root).length, 0);
    assert.match(fixture.root.textContent ?? "", /No paths match both the folder and tag filters/);
  } finally {
    fixture.restore();
  }
});

test("Edit tags files a path into a folder with precise inline errors and clears it", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    await cardButton(fixture, "path-linear-algebra", "Edit tags").props.onClick();
    await fixture.flush();

    const dialog = fixture.find("openDialog");
    const folderInput = dialog.contentContainer!.querySelector<HTMLInputElement>(".lp-folder-input")!;
    const tagsInput = dialog.contentContainer!.querySelector<HTMLInputElement>(".lp-tags-input")!;
    const error = dialog.contentContainer!.querySelector<HTMLElement>(".lp-dialog-error")!;
    const save = () =>
      fixture
        .all("mountButton")
        .find((record) => dialog.contentContainer!.contains(record.container) && record.props.label === "Save tags")!;
    assert.equal(folderInput.value, "", "an unfiled path opens with an empty folder");
    tagsInput.value = "field:systems";

    folderInput.value = "exam//step-2";
    await save().props.onClick();
    await fixture.flush();
    assert.match(error.textContent ?? "", /Folder level 2 is empty/);

    folderInput.value = "x".repeat(41);
    await save().props.onClick();
    await fixture.flush();
    assert.match(error.textContent ?? "", /Folder level 1 is at most 40 characters/);

    assert.equal(
      fixture.calls.filter((call) => call.name === "paths.updateMeta").length,
      0,
      "invalid folders never reach the backend",
    );
    assert.equal(dialog.disposed, 0, "the dialog stays open for a correction");

    folderInput.value = "exam/step-2";
    await save().props.onClick();
    await fixture.flush();
    await fixture.flush();
    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.updateMeta").at(-1)?.input, {
      pathId: "path-linear-algebra",
      tags: ["field:systems"],
      folder: "exam/step-2",
    });
    assert.equal(fixture.paths.get("path-linear-algebra")!.folder, "exam/step-2");
    assert.match(
      fixture.root.querySelector<HTMLElement>('.lp-path-card[data-path-id="path-linear-algebra"]')!.textContent ?? "",
      /Folder: exam\/step-2/,
    );
    assert.equal(dialog.disposed >= 1, true, "a successful save closes the dialog");

    // Clearing the field unfiles the path and the card drops its folder line.
    await cardButton(fixture, "path-linear-algebra", "Edit tags").props.onClick();
    await fixture.flush();
    const reopened = fixture.find("openDialog");
    const reopenedFolder = reopened.contentContainer!.querySelector<HTMLInputElement>(".lp-folder-input")!;
    assert.equal(reopenedFolder.value, "exam/step-2");
    reopenedFolder.value = "";
    const saveReopened = fixture
      .all("mountButton")
      .find((record) => reopened.contentContainer!.contains(record.container) && record.props.label === "Save tags")!;
    await saveReopened.props.onClick();
    await fixture.flush();
    await fixture.flush();
    assert.deepEqual(fixture.calls.filter((call) => call.name === "paths.updateMeta").at(-1)?.input, {
      pathId: "path-linear-algebra",
      tags: ["field:systems"],
      folder: null,
    });
    assert.equal(fixture.paths.get("path-linear-algebra")!.folder, undefined);
    assert.doesNotMatch(
      fixture.root.querySelector<HTMLElement>('.lp-path-card[data-path-id="path-linear-algebra"]')!.textContent ?? "",
      /Folder:/,
    );
  } finally {
    fixture.restore();
  }
});

test("aborting the hub disposes every overview widget and listener", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    const recordsBefore = fixture.records.length;
    const liveOverview = fixture.records.filter(
      (record) => record.container.closest(".lp-overview-pane") !== null,
    );
    assert.ok(liveOverview.length > 0, "cards own buttons and badges");

    fixture.controller.abort();
    await fixture.flush();
    assert.equal(fixture.root.childElementCount, 0);
    assert.ok(
      liveOverview.every((record) => record.disposed >= 1),
      "every overview widget is disposed through its signal",
    );
    assert.ok(recordsBefore > 0);
  } finally {
    fixture.restore();
  }
});

/* ------------------------------------------------------------------------- *
 * Many paths: the overview must stay honest and usable at 40+ paths.
 *
 * The fixture is generated, not hand-written, so the counts are arithmetic:
 * four tags across 40 paths, one in five paths untagged. Titles run opposite
 * to the updated stamps, so "Recently updated" and "Title A–Z" cannot agree by
 * accident, and two deliberate ties prove the tie-break is explicit.
 * ------------------------------------------------------------------------- */

const SCALE_TAGS = ["exam:step-2", "field:ethics", "field:systems", "project:thesis"] as const;
const SCALE_SIZE = 40;

function makeScalePaths(): LearningPath[] {
  const paths: LearningPath[] = [];
  const tiedStamp = new Date(Date.UTC(2026, 0, 1)).toISOString();
  for (let index = 0; index < SCALE_SIZE; index += 1) {
    const base = makePath();
    const tag = SCALE_TAGS[index % 5];
    const tags = index % 5 === 4 || !tag ? [] : [tag];
    // Indices 0 and 1 share an updated stamp; indices 2 and 3 share a title.
    // Every other path varies both, with title order opposite to stamp order.
    const title =
      index === 2 || index === 3
        ? "Scale path tied"
        : `Scale path ${String(SCALE_SIZE - index).padStart(2, "0")}`;
    const updatedAt =
      index <= 1 ? tiedStamp : new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString();
    paths.push({
      ...base,
      id: `scale-${String(index).padStart(2, "0")}`,
      title,
      goal: `Goal for scale path ${index}.`,
      updatedAt,
      ...(tags.length === 0 ? {} : { tags }),
    });
  }
  return paths;
}

function cardIds(root: HTMLElement): string[] {
  return overviewCards(root).map((card) => card.dataset.pathId ?? "");
}

function pagerButton(fixture: ReturnType<typeof createViewFixture>, label: string) {
  const record = fixture
    .all("mountButton")
    .find(
      (entry) =>
        entry.container.closest(".lp-overview-pager") !== null && entry.props.label === label,
    );
  assert.ok(record, `Missing pager control ${label}`);
  return record;
}

function pagerStatus(root: HTMLElement): string {
  const status = root.querySelector<HTMLElement>(".lp-overview-pager-status");
  assert.ok(status, "Missing pager status line");
  return status.textContent ?? "";
}

function countLine(root: HTMLElement): HTMLElement {
  const line = root.querySelector<HTMLElement>(".lp-overview-count");
  assert.ok(line, "the overview always states how many paths are on screen");
  return line;
}

test("40 paths: five cards per page, honest counts, deterministic sorts across pages", async () => {
  const fixture = createViewFixture({
    paths: makeScalePaths(),
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);

    // Paging is presentation, not hiding: five cards at a time, every path
    // reachable through an honest pager, the count line always totals the
    // whole filtered set.
    assert.equal(overviewCards(fixture.root).length, 5);
    assert.equal(countLine(fixture.root).textContent, "40 of 40 paths");
    assert.match(pagerStatus(fixture.root), /Page 1 of 8/);
    assert.equal(pagerButton(fixture, "Previous").props.disabled, true);
    assert.equal(pagerButton(fixture, "Next").props.disabled, false);

    const overviewText = fixture.root.querySelector<HTMLElement>(".lp-overview")!.textContent ?? "";
    // Sorting is ordering, never scheduling or prioritisation.
    assert.doesNotMatch(overviewText, /%|streak|due|hours|days|priority|stale/i);

    const collectPages = async (): Promise<string[]> => {
      const ids: string[] = [];
      for (;;) {
        ids.push(...cardIds(fixture.root));
        const next = pagerButton(fixture, "Next");
        if (next.props.disabled) break;
        await next.props.onClick();
        await fixture.flush();
      }
      return ids;
    };

    // Recently updated is the default: newest first, ties by title. Every
    // one of the 40 paths is reachable through the pager.
    const expectedUpdated = Array.from({ length: SCALE_SIZE - 2 }, (_, offset) => SCALE_SIZE - 1 - offset);
    // Indices 39..2 by descending stamp, then the tie: "Scale path 39" before
    // "Scale path 40" (ids scale-01, scale-00).
    const updatedOrder = await collectPages();
    assert.equal(updatedOrder.length, SCALE_SIZE);
    assert.deepEqual(
      updatedOrder,
      [...expectedUpdated.map((index) => `scale-${String(index).padStart(2, "0")}`), "scale-01", "scale-00"],
    );
    assert.match(pagerStatus(fixture.root), /Page 8 of 8/);
    assert.equal(pagerButton(fixture, "Next").props.disabled, true);

    // The group picker states a count per entry, plus the total.
    const filter = fixture.root.querySelector<HTMLSelectElement>(".lp-overview-filter")!;
    assert.deepEqual(
      [...filter.options].map((option) => [option.value, option.textContent]),
      [
        ["", "All paths (40)"],
        ["exam:step-2", "exam:step-2 (8)"],
        ["field:ethics", "field:ethics (8)"],
        ["field:systems", "field:systems (8)"],
        ["project:thesis", "project:thesis (8)"],
      ],
    );

    // A changed filter returns to page 1 of its own results.
    setSelect(filter, "exam:step-2");
    assert.match(pagerStatus(fixture.root), /Page 1 of 2/);
    assert.equal(countLine(fixture.root).textContent, "8 of 40 paths");
    const tagged = await collectPages();
    assert.deepEqual(
      [...tagged].sort(),
      [0, 5, 10, 15, 20, 25, 30, 35].map((index) => `scale-${String(index).padStart(2, "0")}`),
    );

    // Sort still applies inside the filter: titles ascend as indices descend.
    const sort = () => fixture.root.querySelector<HTMLSelectElement>(".lp-overview-sort")!;
    setSelect(sort(), "title");
    assert.match(pagerStatus(fixture.root), /Page 1 of 2/, "a sort change restarts at page 1");
    assert.deepEqual(
      await collectPages(),
      [35, 30, 25, 20, 15, 10, 5, 0].map((index) => `scale-${String(index).padStart(2, "0")}`),
    );

    // Back to all paths: title order is total, with an explicit id tie-break.
    setSelect(fixture.root.querySelector<HTMLSelectElement>(".lp-overview-filter")!, "");
    const titleOrder = await collectPages();
    assert.equal(titleOrder.length, SCALE_SIZE);
    assert.equal(titleOrder[0], "scale-39", "Scale path 01 comes first");
    assert.ok(
      titleOrder.indexOf("scale-02") < titleOrder.indexOf("scale-03"),
      "equal titles fall through to the id",
    );
    // Titles ascend across every page; the one title tie falls through to id.
    const titleFor = (id: string): string => {
      const n = Number(id.slice("scale-".length));
      if (n === 2 || n === 3) return "Scale path tied";
      return `Scale path ${String(SCALE_SIZE - n).padStart(2, "0")}`;
    };
    for (let index = 1; index < titleOrder.length; index += 1) {
      const [before, after] = [titleOrder[index - 1]!, titleOrder[index]!];
      const byTitle = titleFor(before).localeCompare(titleFor(after));
      assert.ok(
        byTitle < 0 || (byTitle === 0 && before < after),
        `title order breaks at ${before} → ${after}`,
      );
    }
    assert.equal(countLine(fixture.root).textContent, "40 of 40 paths");

    // Switching back reproduces the first ordering exactly: no drift, no
    // dependence on the order the previous sort left in the DOM.
    setSelect(sort(), "updated");
    assert.deepEqual(await collectPages(), updatedOrder);
    setSelect(sort(), "title");
    assert.deepEqual(await collectPages(), titleOrder);
  } finally {
    fixture.restore();
  }
});
