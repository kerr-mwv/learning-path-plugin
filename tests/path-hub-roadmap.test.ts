/** Roadmap lane view tests.
 *
 * Mounted through the real Path Hub: the roadmap is the one lens over a path
 * (one lane per module, node cards, no arrows, dates or order pressure, and no
 * view toggle or graph DOM at all), cards select nodes into the same
 * inspector, and everything disposes with the hub. No browser or model
 * request.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mountPathHub } from "../src/view/path-hub.ts";
import type { LearningPath } from "../src/domain.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture, fire, makeConversation } from "./view-host.ts";

function snapshot(id: string) {
  return makeConversation(id);
}

/** `makePath` with the second module dropped, to model a one-module path. */
function singleModulePath(): LearningPath {
  const path = makePath();
  return { ...path, modules: [path.modules[0]!] };
}

async function mounted(fixture: ReturnType<typeof createViewFixture>): Promise<HTMLElement> {
  const container = fixture.root;
  fixture.context.signal.addEventListener("abort", () => container.replaceChildren());
  mountPathHub(fixture.context, container, fixture.context.signal);
  await fixture.flush();
  return container;
}

function cardAt(root: HTMLElement, laneIndex: number, cardIndex: number): HTMLElement {
  const lane = root.querySelectorAll<HTMLElement>(".lp-lane")[laneIndex];
  assert.ok(lane, `Missing lane ${laneIndex}`);
  const card = lane.querySelectorAll<HTMLElement>(".lp-roadmap-card")[cardIndex];
  assert.ok(card, `Missing card ${cardIndex} in lane ${laneIndex}`);
  return card;
}

test("the roadmap is the only lens: no graph DOM and no view toggle, for any path", async () => {
  for (const paths of [[singleModulePath()], [makePath()]]) {
    const fixture = createViewFixture({
      paths,
      conversations: [snapshot("chat-architect")],
    });
    try {
      await mounted(fixture);
      assert.equal(fixture.all("mountTree").length, 0, "no tree widget is ever mounted");
      assert.equal(
        fixture.all("mountButton").some((entry) =>
          entry.props.label === "Roadmap view" || entry.props.label === "Graph view"),
        false,
        "the removed graph lens leaves no toggle behind",
      );
      assert.equal(fixture.root.querySelectorAll(".lp-graph-card, .lp-graph, .lp-graph-edges").length, 0,
        "no graph DOM is drawn");
      assert.match(
        fixture.root.querySelector<HTMLElement>(".lp-path-pane .lp-pane-title")!.textContent ?? "",
        /Path roadmap/,
      );
      assert.ok(fixture.root.querySelector(".lp-roadmap"), "the roadmap renders without a toggle");
    } finally {
      fixture.restore();
    }
  }
});

test("the roadmap renders module lanes and node cards from recorded structure only", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    await fixture.flush();

    assert.equal(fixture.all("mountTree").length, 0, "no tree widget is ever mounted");
    const lanes = fixture.root.querySelectorAll<HTMLElement>(".lp-lane");
    assert.equal(lanes.length, 2);
    assert.match(lanes[0]!.textContent ?? "", /Structure first/);
    assert.match(lanes[0]!.textContent ?? "", /1\/3 consolidated/);
    assert.match(lanes[1]!.textContent ?? "", /Synthesis/);
    assert.match(lanes[1]!.textContent ?? "", /0\/3 consolidated/);

    const firstCard = cardAt(fixture.root, 0, 0);
    assert.match(firstCard.textContent ?? "", /Node n-holistic/);
    assert.match(firstCard.textContent ?? "", /OSTEP — chapter 26, section 27\.1, pages 301-320/);
    const secondCard = cardAt(fixture.root, 0, 1);
    assert.match(secondCard.textContent ?? "", /1 teaching/);

    const cardBadges = fixture
      .all("mountBadge")
      .filter((badge) => secondCard.contains(badge.container))
      .map((badge) => badge.props.text);
    assert.deepEqual(cardBadges, ["Concept", "In progress"]);

    const wholeBoard = fixture.root.querySelector<HTMLElement>(".lp-roadmap")!.textContent ?? "";
    assert.doesNotMatch(wholeBoard, /%|streak|day|hour|due|next up/i, "no scheduling or ordering pressure");
    assert.doesNotMatch(wholeBoard, /→|→/, "no drawn prerequisite edges");
  } finally {
    fixture.restore();
  }
});

test("a card click selects the node into the shared inspector and marks the card", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    await fixture.flush();

    const card = cardAt(fixture.root, 1, 1);
    assert.equal(card.getAttribute("aria-pressed"), "false");
    fire(card, "click");
    await fixture.flush();

    const inspector = fixture.root.querySelector<HTMLElement>(".lp-inspector")!;
    assert.equal(inspector.dataset.nodeId, "n-checkpoint");
    const selected = fixture.root.querySelectorAll<HTMLElement>(".lp-roadmap-card-selected");
    assert.equal(selected.length, 1);
    assert.match(selected[0]!.textContent ?? "", /Node n-checkpoint/);
    assert.equal(selected[0]!.getAttribute("aria-pressed"), "true");
    assert.match(inspector.textContent ?? "", /Node n-checkpoint/);
  } finally {
    fixture.restore();
  }
});

test("aborting the hub while the roadmap is showing disposes its badges and DOM", async () => {
  const fixture = createViewFixture({
    paths: [makePath()],
    conversations: [snapshot("chat-architect")],
  });
  try {
    await mounted(fixture);
    await fixture.flush();
    const roadmapBadges = fixture
      .all("mountBadge")
      .filter((badge) => badge.container.closest(".lp-roadmap") !== null);
    assert.ok(roadmapBadges.length >= 12, "every node carries type and progression badges");

    fixture.controller.abort();
    await fixture.flush();
    assert.equal(fixture.root.childElementCount, 0);
    assert.ok(
      roadmapBadges.every((badge) => badge.disposed >= 1),
      "roadmap badges are disposed through their signal",
    );
  } finally {
    fixture.restore();
  }
});
