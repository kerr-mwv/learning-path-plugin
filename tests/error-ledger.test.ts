/** Error Ledger frontend tests.
 *
 * The ledger renders authoritative path state: own errors grouped by root cause,
 * inherited active watchpoints from interleaved/upstream nodes, and inline
 * resolve/reflection controls. Writes are reported to the caller; the ledger
 * never mutates the path itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LearningPath } from "../src/domain.ts";
import { createErrorLedger } from "../src/view/error-ledger.ts";
import type { ErrorLedgerChange } from "../src/view/error-ledger.ts";
import { AT, makePath } from "./fixtures.ts";
import { createViewFixture } from "./view-host.ts";
import type { MountRecord, ViewFixture } from "./view-host.ts";

function ledgerPath(): LearningPath {
  const base = makePath();
  return {
    ...base,
    modules: base.modules.map((module) => ({
      ...module,
      nodes: module.nodes.map((node) => {
        if (node.id === "n-holistic") {
          return {
            ...node,
            errors: [
              ...node.errors,
              {
                id: "err-inherited",
                category: "prerequisite_gap" as const,
                summary: "Missing the base case behind the map.",
                resolved: false,
                createdAt: AT,
              },
            ],
          };
        }
        if (node.id === "n-skill") {
          return {
            ...node,
            interleavesNodeIds: ["n-concept", "n-holistic"],
            errors: [
              ...node.errors,
              {
                id: "err-noted",
                category: "misconception" as const,
                summary: "Treats notation as the mechanism.",
                resolved: false,
                createdAt: AT,
                notes: "Say the mechanism out loud before writing symbols.",
              },
            ],
          };
        }
        return node;
      }),
    })),
  };
}

function buttonFor(
  fixture: ViewFixture,
  label: string,
  errorId: string,
): MountRecord {
  return fixture.findLast(
    "mountButton",
    (record) =>
      record.props.label === label &&
      record.container.closest(`[data-error-id="${errorId}"]`) !== null,
  );
}

test("error ledger groups by root cause and reports resolve and note changes", async () => {
  const path = ledgerPath();
  const fixture = createViewFixture({ paths: [path] });
  const updates: { errorId: string; change: ErrorLedgerChange }[] = [];
  const selected: string[] = [];
  try {
    const node = path.modules[0]!.nodes.find((candidate) => candidate.id === "n-skill")!;
    const ledger = createErrorLedger(fixture.context, fixture.root, fixture.context.signal, {
      update(errorId, change) {
        updates.push({ errorId, change });
      },
      selectNode(nodeId) {
        selected.push(nodeId);
      },
    });
    ledger.render(path, node);
    await fixture.flush();

    const groups = [...fixture.root.querySelectorAll<HTMLElement>(".lp-error-group")];
    assert.deepEqual(
      groups.map((group) => group.dataset.category),
      ["misconception", "procedural_slip"],
    );
    assert.match(groups[0]!.textContent ?? "", /Misconception \(1\)/);
    assert.match(groups[1]!.textContent ?? "", /Procedural slip \(1\)/);
    assert.match(
      groups[0]!.querySelector(".lp-error-entry")!.textContent ?? "",
      /Treats notation as the mechanism/,
    );
    assert.match(
      groups[0]!.querySelector(".lp-error-note")!.textContent ?? "",
      /Say the mechanism out loud/,
    );

    const inherited = fixture.root.querySelector<HTMLElement>(
      '.lp-watchpoint-inherited[data-source-node-id="n-holistic"]',
    );
    assert.ok(inherited, "the ledger highlights an upstream watchpoint");
    assert.match(inherited.textContent ?? "", /Prerequisite gap/);
    assert.match(inherited.textContent ?? "", /Missing the base case behind the map/);
    assert.match(inherited.textContent ?? "", /From Node n-holistic/);
    assert.equal(
      fixture.root.querySelectorAll(".lp-watchpoint-inherited").length,
      1,
      "own errors are grouped separately, not repeated as inherited watchpoints",
    );

    await buttonFor(fixture, "Mark resolved", "err-skill").props.onClick();
    assert.deepEqual(updates.at(-1), { errorId: "err-skill", change: { resolved: true } });

    await buttonFor(fixture, "Clear note", "err-noted").props.onClick();
    assert.deepEqual(updates.at(-1), { errorId: "err-noted", change: { notes: null } });

    const textarea = fixture.root.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Reflection note for Drops a sign while expanding."]',
    )!;
    assert.ok(textarea, "each entry has its own reflection editor");
    textarea.value = "Re-read the expansion before multiplying.";
    await buttonFor(fixture, "Save note", "err-skill").props.onClick();
    assert.deepEqual(updates.at(-1), {
      errorId: "err-skill",
      change: { notes: "Re-read the expansion before multiplying." },
    });

    const sourceLink = fixture.findLast(
      "mountButton",
      (record) =>
        record.props.label === "Node n-holistic" &&
        record.container.closest(".lp-watchpoint-inherited") !== null,
    );
    await sourceLink.props.onClick();
    assert.deepEqual(selected, ["n-holistic"]);

    // A resolved entry can be reopened; the label tells the truth.
    const resolvedPath: LearningPath = {
      ...path,
      modules: path.modules.map((module) => ({
        ...module,
        nodes: module.nodes.map((candidate) =>
          candidate.id === "n-skill"
            ? {
                ...candidate,
                errors: candidate.errors.map((entry) =>
                  entry.id === "err-skill"
                    ? { ...entry, resolved: true, resolvedAt: AT }
                    : entry,
                ),
              }
            : candidate,
        ),
      })),
    };
    ledger.render(resolvedPath, resolvedPath.modules[0]!.nodes[2]!);
    await fixture.flush();
    await buttonFor(fixture, "Mark unresolved", "err-skill").props.onClick();
    assert.deepEqual(updates.at(-1), { errorId: "err-skill", change: { resolved: false } });

    ledger.render(null, null);
    assert.match(fixture.root.textContent ?? "", /Select a node to inspect its errors/);
    ledger.dispose();
    assert.equal(fixture.root.querySelector(".lp-error-ledger"), null);
  } finally {
    fixture.restore();
  }
});

test("a node without errors still shows that inherited watchpoints exist", async () => {
  const path = ledgerPath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const node = path.modules[0]!.nodes.find((candidate) => candidate.id === "n-concept")!;
    const ledger = createErrorLedger(fixture.context, fixture.root, fixture.context.signal, {
      update() {},
    });
    ledger.render(path, node);
    await fixture.flush();

    assert.match(fixture.root.textContent ?? "", /No errors are logged on this node/);
    assert.match(fixture.root.textContent ?? "", /Missing the base case behind the map/);
    assert.equal(fixture.root.querySelectorAll(".lp-inherited-watchpoints").length, 1);
    ledger.dispose();
  } finally {
    fixture.restore();
  }
});
