/** Advisory pivot banner tests.
 *
 * The card is quiet and advisory: it explains the diagnosis, exposes exactly the
 * three learner decisions, and never mutates the path itself. Accept/dismiss
 * state transitions are proven against the real backend in diagnostics.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPivotBanner, pivotDiscussionPrompt } from "../src/view/pivot-banner.ts";
import type { PivotDecision } from "../src/view/pivot-banner.ts";
import { makePath } from "./fixtures.ts";
import { createViewFixture } from "./view-host.ts";

test("the advisory banner offers accept, discuss and dismiss for a pending pivot only", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  const decisions: { pivotId: string; decision: PivotDecision }[] = [];
  const discussions: string[] = [];
  try {
    const banner = createPivotBanner(fixture.context, fixture.root, fixture.context.signal, {
      decide(pivotId, decision) {
        decisions.push({ pivotId, decision });
      },
      discuss(pivot, node) {
        discussions.push(pivotDiscussionPrompt(pivot, node));
      },
    });
    const node = path.modules[0]!.nodes.find((candidate) => candidate.id === "n-skill")!;
    banner.render(path, node);
    await fixture.flush();

    const card = fixture.root.querySelector<HTMLElement>(".lp-pivot-card")!;
    assert.ok(card, "a pending pivot renders an advisory card");
    assert.equal(card.dataset.pivotId, "pivot-skill");
    assert.equal(card.dataset.proposalType, "skill");
    assert.match(card.textContent ?? "", /Advisory skill proposal/);
    assert.match(card.textContent ?? "", /Add a sign-tracking drill/);
    assert.match(card.textContent ?? "", /Mechanics keep slipping while the idea is understood/);
    assert.match(card.textContent ?? "", /Nothing changes until you decide/);

    const labels = fixture
      .all("mountButton")
      .filter((record) => record.container.closest(".lp-pivot-card") !== null)
      .map((record) => record.props.label);
    assert.deepEqual(labels, ["Accept & Insert Node", "Discuss with Architect", "Dismiss"]);

    const click = async (label: string) => {
      const record = fixture.findLast(
        "mountButton",
        (candidate) =>
          candidate.props.label === label &&
          candidate.container.closest(".lp-pivot-card") !== null,
      );
      await record.props.onClick();
    };

    await click("Accept & Insert Node");
    await click("Dismiss");
    await click("Discuss with Architect");
    assert.deepEqual(decisions, [
      { pivotId: "pivot-skill", decision: "accept" },
      { pivotId: "pivot-skill", decision: "dismiss" },
    ]);
    assert.equal(discussions.length, 1);
    assert.match(discussions[0]!, /skill pivot on the node "Node n-skill"/);
    assert.match(discussions[0]!, /Mechanics keep slipping/);
    assert.match(discussions[0]!, /Do not rewrite the path without my explicit agreement/);

    // Dismissed/accepted suggestions and nodes without pending pivots render nothing.
    const settled = {
      ...node,
      pivotSuggestions: node.pivotSuggestions.map((pivot) => ({
        ...pivot,
        status: "dismissed" as const,
        resolvedAt: "2026-02-01T00:00:00.000Z",
      })),
    };
    banner.render(path, settled);
    await fixture.flush();
    assert.equal(fixture.root.querySelector(".lp-pivot-card"), null);

    const clean = path.modules[0]!.nodes.find((candidate) => candidate.id === "n-concept")!;
    banner.render(path, clean);
    await fixture.flush();
    assert.equal(fixture.root.querySelector(".lp-pivot-card"), null);

    banner.dispose();
    assert.equal(fixture.root.querySelector(".lp-pivot-banner"), null);
  } finally {
    fixture.restore();
  }
});
