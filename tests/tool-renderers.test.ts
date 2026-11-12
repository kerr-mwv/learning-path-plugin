/** Compact learning_path_* renderer tests.
 *
 * Rendering only: each native result becomes one short card, errors stay readable,
 * and unregistering removes the renderers and their mounts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginToolRenderProps } from "learnharness-plugin-api";
import { registerLearningPathToolRenderers } from "../src/view/tool-renderers.ts";
import { LEARNING_PATH_TOOL_NAMES } from "../src/tool-names.ts";
import { createViewFixture } from "./view-host.ts";

function props(
  toolName: string,
  overrides: Partial<PluginToolRenderProps> = {},
): PluginToolRenderProps {
  return {
    toolName,
    toolCallId: "call-1",
    input: {},
    state: "output-available",
    signal: new AbortController().signal,
    ...overrides,
  };
}

test("registers a compact renderer for every learning_path tool", () => {
  const fixture = createViewFixture();
  try {
    const dispose = registerLearningPathToolRenderers(fixture.context);
    assert.deepEqual(
      [...fixture.toolRenderers.keys()].sort(),
      [...LEARNING_PATH_TOOL_NAMES].sort(),
    );
    dispose();
    assert.equal(fixture.toolRenderers.size, 0);
  } finally {
    fixture.restore();
  }
});

test("renders brief, progress, error and pivot results as short readable cards", () => {
  const fixture = createViewFixture();
  try {
    registerLearningPathToolRenderers(fixture.context);
    const cases: {
      toolName: string;
      output: unknown;
      expected: RegExp;
    }[] = [
      {
        toolName: "learning_path_get_brief",
        output: {
          nodeTitle: "Node n-contrast",
          watchpoints: [{}, {}],
          artifact: { label: "Retrieval cue / flashcard seed" },
        },
        expected: /Brief for Node n-contrast.*2 watchpoints.*Retrieval cue/s,
      },
      {
        toolName: "learning_path_update_progress",
        output: { nodeTitle: "Node n-concept", progression: "consolidated" },
        expected: /Node n-concept: consolidated/,
      },
      {
        toolName: "learning_path_log_error",
        output: {
          nodeTitle: "Node n-skill",
          category: "procedural_slip",
          summary: "Drops a sign while expanding.",
        },
        expected: /Logged Procedural slip on Node n-skill.*Drops a sign/s,
      },
      {
        toolName: "learning_path_suggest_pivot",
        output: {
          nodeTitle: "Node n-concept",
          proposalType: "bridge",
          title: "Repair prerequisite",
        },
        expected: /Advisory bridge node: Repair prerequisite.*Pending; the path was not changed/s,
      },
    ];

    for (const entry of cases) {
      const container = fixture.root.ownerDocument.createElement("div");
      fixture.root.append(container);
      const renderer = fixture.toolRenderers.get(entry.toolName);
      assert.ok(renderer);
      const cleanup = renderer.mount(container, props(entry.toolName, { output: entry.output }));
      assert.match(container.textContent ?? "", entry.expected);
      assert.equal(container.querySelectorAll(".lp-tool-card").length, 1);
      if (typeof cleanup === "function") cleanup();
      assert.equal(container.childElementCount, 0, "cleanup removes the card");
      container.remove();
    }
  } finally {
    fixture.restore();
  }
});

test("shows streaming and error states without model HTML", () => {
  const fixture = createViewFixture();
  try {
    registerLearningPathToolRenderers(fixture.context);
    const streaming = fixture.root.ownerDocument.createElement("div");
    const errored = fixture.root.ownerDocument.createElement("div");
    fixture.root.append(streaming, errored);

    const brief = fixture.toolRenderers.get("learning_path_get_brief")!;
    brief.mount(streaming, props("learning_path_get_brief", { state: "input-streaming" }));
    assert.match(streaming.textContent ?? "", /Reading the Learning Path brief.*Preparing/s);

    const error = fixture.toolRenderers.get("learning_path_log_error")!;
    error.mount(
      errored,
      props("learning_path_log_error", {
        state: "output-error",
        errorText: "<img src=x onerror=alert(1)> not a node",
      }),
    );
    assert.match(errored.textContent ?? "", /<img src=x onerror=alert\(1\)> not a node/);
    assert.equal(errored.querySelectorAll("img").length, 0, "error text is textContent, not HTML");
    assert.equal(errored.querySelector(".lp-tool-card")?.getAttribute("data-error"), "true");
  } finally {
    fixture.restore();
  }
});
