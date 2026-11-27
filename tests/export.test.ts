/** Export formatting tests: pure JSON/Markdown rendering and the browser download shim. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const { parseHTML } = createRequire(import.meta.url)("linkedom") as {
  parseHTML(html: string): { document: Document };
};
import { parseLearningPath } from "../src/domain.ts";
import type { LearningPath } from "../src/domain.ts";
import {
  EXPORT_FORMATS,
  exportFilename,
  exportLearningPath,
  exportLearningPathAsJson,
  exportLearningPathAsMarkdown,
  triggerBrowserDownload,
} from "../src/export.ts";
import { ITEM_ID, ITEM_ID_2, makeItem, makePath } from "./fixtures.ts";
import type { WorkspaceExportItem } from "../src/export.ts";

function withLearnerNotes(path: LearningPath): LearningPath {
  return {
    ...path,
    modules: path.modules.map((module) => ({
      ...module,
      nodes: module.nodes.map((node) => ({
        ...node,
        ...(node.id === "n-skill"
          ? {
              artifactNote: "Used a signed-number table to catch the slip.",
              errors: node.errors.map((error) => ({
                ...error,
                notes: "Slow down on every distribution step.",
              })),
            }
          : {}),
      })),
    })),
  };
}

test("JSON export is pretty, validated and round-trips through the domain parser", () => {
  const path = makePath();
  const json = exportLearningPathAsJson(path);
  assert.ok(json.endsWith("\n"));
  assert.match(json, /^\{\n  "id": "path-linear-algebra",/);
  assert.deepEqual(parseLearningPath(JSON.parse(json)), parseLearningPath(path));
});

test("Markdown export renders the full path without losing learner state", () => {
  const path = withLearnerNotes(makePath());
  const markdown = exportLearningPathAsMarkdown(path);

  assert.match(markdown, /^# Linear algebra from canon/);
  assert.match(markdown, /Build durable linear-algebra understanding\./);
  assert.match(markdown, /- \*\*Path ID:\*\* `path-linear-algebra`/);
  assert.match(markdown, /- \*\*Progress:\*\* 1 of 6 nodes consolidated · 2 in progress/);
  assert.match(markdown, /- \*\*Created:\*\* 2026-01-31T09:30:00\.000Z/);
  assert.match(markdown, /- \*\*Updated:\*\* 2026-01-31T09:30:00\.000Z/);
  assert.match(markdown, /- \*\*Default artifact:\*\* Retrieval cue \/ flashcard seed/);

  const tagged = exportLearningPathAsMarkdown({ ...path, tags: ["exam:step-2", "field:systems"] });
  assert.match(tagged, /- \*\*Tags:\*\* exam:step-2, field:systems/);
  assert.doesNotMatch(markdown, /\*\*Tags:/, "an untagged path exports no empty tags line");

  const filed = exportLearningPathAsMarkdown({ ...path, folder: "exam/step-2" });
  assert.match(filed, /- \*\*Folder:\*\* exam\/step-2/);
  assert.doesNotMatch(markdown, /\*\*Folder:/, "an unfiled path exports no empty folder line");

  assert.match(markdown, /## Source Spine/);
  assert.match(markdown, /- \*\*Mode:\*\* Canonical references/);
  assert.match(markdown, /OSTEP — Arpaci-Dusseau — edition 1\.0 — textbook/);

  assert.match(markdown, /## Modules/);
  assert.match(markdown, /### Module 1: Structure first/);
  assert.match(markdown, /### Module 2: Synthesis/);
  assert.match(markdown, /#### Node n-concept/);
  assert.match(
    markdown,
    /- \*\*Type:\*\* Concept · \*\*Progression:\*\* In progress · \*\*ID:\*\* `n-concept`/,
  );
  assert.match(markdown, /- \*\*Goal:\*\* Understand n-concept from first principles\./);
  assert.match(
    markdown,
    /- \*\*Source anchor:\*\* OSTEP — chapter 26, section 27\.1, pages 301-320/,
  );
  assert.match(
    markdown,
    /- \*\*Light pre-reading:\*\* Skim the module overview and the running example\./,
  );
  assert.match(markdown, /- \*\*Interleaves:\*\* Node n-holistic \(`n-holistic`\)/);
  assert.match(
    markdown,
    /- \*\*Artifact:\*\* Micro-code \/ implementation — Write the smallest failing interpreter\./,
  );
  assert.match(markdown, /- \*\*Artifact note:\*\* Used a signed-number table to catch the slip\./);
  assert.match(markdown, /- \*\*Child sessions:\*\*/);
  assert.match(markdown, /  - Teaching: First teaching chat \(`chat-1`\)/);

  assert.match(markdown, /- \*\*Error ledger:\*\*/);
  assert.match(markdown, /  - \[x\] \*\*Misconception:\*\* Assumes the map is the proof\./);
  assert.match(
    markdown,
    /  - \[ \] \*\*Procedural slip:\*\* Drops a sign while expanding\. — Notes: Slow down on every distribution step\./,
  );
  assert.match(markdown, /- \*\*Pivot suggestions:\*\*/);
  assert.match(
    markdown,
    /  - \[pending\] \*\*Skill — Add a sign-tracking drill:\*\* Mechanics keep slipping while the idea is understood\./,
  );
  assert.match(
    markdown,
    /  - \[dismissed\] \*\*Bridge — Repair matrix multiplication:\*\* Prerequisite gap surfaced in practice\./,
  );

  // Path-level defaults and plugin settings still determine an effective artifact.
  assert.match(markdown, /#### Node n-contrast[\s\S]*?- \*\*Artifact:\*\* Retrieval cue \/ flashcard seed/);
});

test("Markdown export covers uploaded corpora and canonical supplements", () => {
  const base = makePath();
  const uploaded: LearningPath = {
    ...base,
    artifactDefault: null,
    sourceSpine: {
      mode: "uploaded",
      sources: [
        {
          sourceId: "123e4567-e89b-12d3-a456-426614174000",
          name: "my-notes.md",
          uploadedAt: "2026-01-31T09:30:00.000Z",
        },
      ],
      supplements: [
        { title: "Reference Manual", author: "A. Writer", kind: "specification" },
      ],
    },
  };
  const markdown = exportLearningPathAsMarkdown(uploaded);
  assert.match(markdown, /- \*\*Mode:\*\* Uploaded corpus/);
  assert.match(markdown, /my-notes\.md \(`123e4567-e89b-12d3-a456-426614174000`\)/);
  assert.match(markdown, /- \*\*Canonical supplement:\*\* Reference Manual — A\. Writer — specification/);
});

test("exportFilename slugifies the title, stays bounded and falls back to the path id", () => {
  assert.equal(exportFilename({ id: "p1", title: "Linear Algebra: From Canon!" }, "json"), "linear-algebra-from-canon.json");
  assert.equal(exportFilename({ id: "p1", title: "Linear Algebra: From Canon!" }, "markdown"), "linear-algebra-from-canon.md");
  assert.equal(exportFilename({ id: "Path_ID:42", title: "!!! ???" }, "json"), "path-id-42.json");
  assert.equal(exportFilename({ id: "!!!", title: "" }, "markdown"), "learning-path.md");
  const long = exportFilename({ id: "p1", title: `${"Word ".repeat(40)}end` }, "json");
  assert.ok(long.length <= 85, long);
  assert.match(long, /^word-word/);
});

test("exportLearningPath validates the format and returns matching metadata", () => {
  const path = makePath();
  assert.deepEqual(EXPORT_FORMATS, ["json", "markdown"]);
  const json = exportLearningPath(path, "json");
  assert.equal(json.pathId, path.id);
  assert.equal(json.title, path.title);
  assert.equal(json.format, "json");
  assert.equal(json.filename, "linear-algebra-from-canon.json");
  assert.equal(json.mimeType, "application/json");
  assert.equal(json.content, exportLearningPathAsJson(path));

  const markdown = exportLearningPath(path, "markdown");
  assert.equal(markdown.format, "markdown");
  assert.equal(markdown.filename, "linear-algebra-from-canon.md");
  assert.equal(markdown.mimeType, "text/markdown");
  assert.equal(markdown.content, exportLearningPathAsMarkdown(path));

  assert.throws(() => exportLearningPath(path, "pdf" as never), /format must be one of/);
});

test("Markdown export carries the workspace ledger with note content verbatim, newest last", () => {
  const path = makePath();
  assert.doesNotMatch(exportLearningPathAsMarkdown(path), /## Workspace/, "an empty workspace exports no section");

  const verbatim = "# Exactly as written\n\n- a  spaced  list\n\n```js\n  keepIndenting();\n```\n\n";
  const items: WorkspaceExportItem[] = [
    {
      item: makeItem({ links: [{ to: "n-concept", rel: "informs" }], caption: "From Tuesday" }),
      content: verbatim,
    },
    {
      item: makeItem({
        id: ITEM_ID_2,
        kind: "source",
        title: "A referenced paper",
        sourceId: "123e4567-e89b-12d3-a456-426614174000",
        addedAt: "2026-02-01T00:00:00.000Z",
        links: [],
      }),
      content: null,
    },
  ];
  const markdown = exportLearningPathAsMarkdown(path, undefined, items);

  assert.match(markdown, /## Workspace\n\nThe learner's own material for this path, oldest first\./);
  // Oldest first, newest last: the ledger keeps its flat order.
  assert.ok(markdown.indexOf("Feynman notes on vector spaces") < markdown.indexOf("A referenced paper"));
  assert.match(markdown, /#### Feynman notes on vector spaces/);
  assert.match(markdown, /- \*\*Kind:\*\* note · \*\*Added by:\*\* learner · \*\*Added at:\*\* 2026-01-31T09:30:00\.000Z/);
  assert.match(markdown, /- \*\*Links:\*\* informs → Node n-concept/);
  assert.match(markdown, /- \*\*Caption:\*\* From Tuesday/);
  assert.ok(markdown.includes(verbatim.replace(/\n+$/, "")), "note content round-trips exactly as stored");
  assert.match(markdown, /- \*\*Source:\*\* `123e4567-e89b-12d3-a456-426614174000` \(in the global sources store\)/);
  assert.doesNotMatch(markdown, /#### A referenced paper[\s\S]*?\*\*Content/, "source items carry no content block");

  const exported = exportLearningPath(path, "markdown", undefined, items);
  assert.equal(exported.content, markdown, "the RPC wrapper renders the same bytes");
});

test("triggerBrowserDownload clicks one temporary anchor and cleans it up", () => {
  const { document } = parseHTML("<!doctype html><html><body><main></main></body></html>");
  const exported = exportLearningPath(makePath(), "markdown");
  const appended: HTMLElement[] = [];
  let clicks = 0;
  const prototype = document.defaultView!.HTMLAnchorElement.prototype;
  const originalClick = prototype.click;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const objectUrls: string[] = [];
  const revoked: string[] = [];
  URL.createObjectURL = ((blob: Blob) => {
    objectUrls.push(`blob:test-${objectUrls.length + 1}`);
    assert.equal(blob.type, "text/markdown;charset=utf-8");
    return objectUrls.at(-1)!;
  }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {
    revoked.push(url);
  }) as typeof URL.revokeObjectURL;
  prototype.click = function click(this: HTMLAnchorElement) {
    clicks += 1;
    const parent = this.parentElement;
    assert.ok(parent, "the anchor is attached before it is clicked");
    appended.push(this);
  };
  try {
    triggerBrowserDownload(document, exported);
  } finally {
    prototype.click = originalClick;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }

  assert.equal(clicks, 1);
  assert.equal(document.querySelectorAll(".lp-export-download").length, 0, "the anchor removes itself");
  assert.equal(document.body.childElementCount, 1, "only the test's main remains");
  const anchor = appended[0] as HTMLAnchorElement;
  assert.equal(anchor.download, exported.filename);
  assert.equal(anchor.dataset.exportFormat, "markdown");
  assert.equal(anchor.dataset.exportFilename, exported.filename);
  assert.equal(anchor.rel, "noopener");
  assert.equal(anchor.href, objectUrls[0]);
  assert.deepEqual(revoked, objectUrls);
});

test("triggerBrowserDownload falls back to an encoded data URL without Blob support", () => {
  const { document } = parseHTML("<!doctype html><html><body><main></main></body></html>");
  const exported = exportLearningPath(makePath(), "json");
  const originalCreate = URL.createObjectURL;
  const prototype = document.defaultView!.HTMLAnchorElement.prototype;
  const originalClick = prototype.click;
  let href = "";
  (URL as { createObjectURL?: unknown }).createObjectURL = undefined;
  prototype.click = function click(this: HTMLAnchorElement) {
    href = this.getAttribute("href") ?? "";
  };
  try {
    triggerBrowserDownload(document, exported);
  } finally {
    prototype.click = originalClick;
    (URL as { createObjectURL?: unknown }).createObjectURL = originalCreate;
  }
  const prefix = "data:application/json;charset=utf-8,";
  assert.ok(href.startsWith(prefix), href);
  assert.equal(decodeURIComponent(href.slice(prefix.length)), exported.content);
});
