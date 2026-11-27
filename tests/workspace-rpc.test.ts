/** Workspace backend operations.
 *
 * Verifies the JSON bridge the Node Inspector uses: verbatim note storage, the
 * bounded read, learner-filing metadata updates, deletion, and the fact that no
 * agent tool can write learner items. Uses the same in-process host as the
 * session RPC tests; no model request is made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  WORKSPACES_DIRECTORY,
  WORKSPACE_FILES_DIRECTORY,
  openLearningPathStore,
} from "../src/store.ts";
import { MAX_WORKSPACE_NOTE_BYTES } from "../src/domain.ts";
import { makeItem, makePath } from "./fixtures.ts";
import { createHost } from "./host.ts";
import type { TestHost } from "./host.ts";
import { EVENT_WORKSPACE_CHANGED } from "../src/topics.ts";

function hostWithPath(): { host: TestHost; directory: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "learning-path-ws-rpc-"));
  openLearningPathStore(directory).savePath(makePath());
  return { host: createHost({ dataDirectory: directory }), directory };
}

/** A well-formed item id that names no stored item. */
const UNKNOWN_ITEM_ID = "3f2504e0-4f89-11d3-9a0c-0305e82c3309";

function close(host: TestHost, directory: string): void {
  host.close();
  fs.rmSync(directory, { recursive: true, force: true });
}

test("workspace.saveNote stores the learner's Markdown verbatim and links it to a node", async () => {
  const { host, directory } = hostWithPath();
  try {
    // Leading whitespace, an H1 and a code fence: nothing may be reflowed.
    const markdown = "\n# Unformatted exactly as written\n\n- a  list with two  spaces\n\n```js\n  indent();\n```\n\n";
    const saved = await host.call<{
      item: { id: string; kind: string; title: string; addedBy: string; links: { to: string; rel: string }[]; byteSize: number };
    }>("workspace.saveNote", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      title: "Feynman notes on vector spaces",
      markdown,
    });
    assert.equal(saved.item.kind, "note");
    assert.equal(saved.item.title, "Feynman notes on vector spaces");
    assert.equal(saved.item.addedBy, "learner");
    assert.deepEqual(saved.item.links, [{ to: "n-skill", rel: "informs" }]);
    assert.equal(saved.item.byteSize, Buffer.byteLength(markdown, "utf8"));
    assert.ok(host.events.some((event) => event.topic === EVENT_WORKSPACE_CHANGED));

    // Files are the truth: the content file carries the exact bytes.
    const filesDir = path.join(directory, WORKSPACES_DIRECTORY, "path-linear-algebra", WORKSPACE_FILES_DIRECTORY);
    const entry = fs.readdirSync(filesDir)[0]!;
    const contentFile = path.join(filesDir, entry);
    // readWorkspaceItemContent strips frontmatter; raw file has frontmatter + markdown.
    const raw = fs.readFileSync(contentFile, "utf8");
    assert.ok(raw.includes(markdown), "the raw file contains the markdown body");

    const read = await host.call<{ item: { id: string }; content: string | null }>("workspace.readItem", {
      pathId: "path-linear-algebra",
      itemId: saved.item.id,
    });
    assert.equal(read.content, markdown, "workspace.readItem returns the note verbatim");

    const reopened = openLearningPathStore(directory);
    assert.equal(reopened.workspace("path-linear-algebra")?.items.length, 1);
  } finally {
    close(host, directory);
  }
});

test("workspace.saveNote takes an optional links array: unlinked or linked to several nodes", async () => {
  const { host, directory } = hostWithPath();
  try {
    // A note created unlinked: the links array is simply empty.
    const unlinked = await host.call<{ item: { links: unknown[] } }>("workspace.saveNote", {
      pathId: "path-linear-algebra",
      title: "Loose scratchpad",
      markdown: "body",
      links: [],
    });
    assert.deepEqual(unlinked.item.links, []);

    // One note linked to several nodes at once, relations as sent.
    const linked = await host.call<{ item: { links: { to: string; rel: string }[] } }>(
      "workspace.saveNote",
      {
        pathId: "path-linear-algebra",
        title: "Feynman notes on vector spaces",
        markdown: "body",
        links: [
          { to: "n-skill", rel: "informs" },
          { to: "n-concept", rel: "informs" },
          { to: "n-holistic", rel: "grounds" },
        ],
      },
    );
    assert.deepEqual(linked.item.links, [
      { to: "n-skill", rel: "informs" },
      { to: "n-concept", rel: "informs" },
      { to: "n-holistic", rel: "grounds" },
    ]);

    // nodeId/rel stay the single-node shorthand when links is absent.
    const shorthand = await host.call<{ item: { links: { to: string; rel: string }[] } }>(
      "workspace.saveNote",
      { pathId: "path-linear-algebra", nodeId: "n-skill", title: "Shorthand", markdown: "body" },
    );
    assert.deepEqual(shorthand.item.links, [{ to: "n-skill", rel: "informs" }]);

    // Every link still resolves against a real node before anything is written.
    await assert.rejects(
      () =>
        host.call("workspace.saveNote", {
          pathId: "path-linear-algebra",
          title: "Broken link",
          markdown: "body",
          links: [{ to: "n-missing", rel: "informs" }],
        }),
      /unknown node id "n-missing"/,
    );
    await assert.rejects(
      () =>
        host.call("workspace.saveNote", {
          pathId: "path-linear-algebra",
          title: "Malformed links",
          markdown: "body",
          links: "n-skill",
        }),
      /links must be an array/,
    );
    const stored = openLearningPathStore(directory).workspace("path-linear-algebra")!.items;
    assert.equal(stored.length, 3, "a rejected save materializes nothing");
  } finally {
    close(host, directory);
  }
});

test("workspace.saveNote validates path, title and content bound before writing", async () => {
  const { host, directory } = hostWithPath();
  try {
    await assert.rejects(
      () => host.call("workspace.saveNote", { pathId: "missing", title: "t", markdown: "x" }),
      /Unknown path: missing/,
    );
    await assert.rejects(
      () => host.call("workspace.saveNote", { pathId: "path-linear-algebra", title: "   ", markdown: "x" }),
      /title must not be blank/,
    );
    await assert.rejects(
      () => host.call("workspace.saveNote", { pathId: "path-linear-algebra", title: "t", markdown: "   " }),
      /markdown must not be blank/,
    );
    await assert.rejects(
      () =>
        host.call("workspace.saveNote", {
          pathId: "path-linear-algebra",
          title: "t",
          markdown: "x".repeat(MAX_WORKSPACE_NOTE_BYTES + 1),
        }),
      /markdown must be at most/,
    );
    await assert.rejects(
      () =>
        host.call("workspace.saveNote", {
          pathId: "path-linear-algebra",
          nodeId: "n-missing",
          title: "t",
          markdown: "x",
        }),
      /unknown node id "n-missing"/,
    );
    await assert.rejects(
      () =>
        host.call("workspace.saveNote", {
          pathId: "path-linear-algebra",
          nodeId: "n-skill",
          rel: "grounds_but_worse",
          title: "t",
          markdown: "x",
        }),
      /rel must be one of/,
    );
    assert.equal(
      openLearningPathStore(directory).workspace("path-linear-algebra"),
      null,
      "a rejected save materializes nothing",
    );
  } finally {
    close(host, directory);
  }
});

test("workspace.list is null before the first item and returns the manifest after", async () => {
  const { host, directory } = hostWithPath();
  try {
    const before = await host.call<{ workspace: unknown }>("workspace.list", {
      pathId: "path-linear-algebra",
    });
    assert.equal(before.workspace, null);
    await assert.rejects(() => host.call("workspace.list", { pathId: "missing" }), /Unknown path/);

    await host.call("workspace.saveNote", {
      pathId: "path-linear-algebra",
      title: "Feynman notes on vector spaces",
      markdown: "body",
    });
    const after = await host.call<{ workspace: { items: { title: string }[] | null } }>(
      "workspace.list",
      { pathId: "path-linear-algebra" },
    );
    assert.deepEqual(
      (after.workspace?.items ?? []).map((item) => item.title),
      ["Feynman notes on vector spaces"],
    );
  } finally {
    close(host, directory);
  }
});

test("workspace.readItem is bounded and refuses unknown or file-less items", async () => {
  const { host, directory } = hostWithPath();
  try {
    const store = openLearningPathStore(directory);
    store.saveSource({ name: "paper.md", markdown: "source body" });
    const sources = store.sources();
    store.saveWorkspaceItem(
      "path-linear-algebra",
      { kind: "source", title: "A paper", addedBy: "learner", sourceId: sources[0]!.sourceId },
    );
    store.saveWorkspaceItem("path-linear-algebra", makeItem(), "note body");

    await assert.rejects(
      () =>
        host.call("workspace.readItem", {
          pathId: "path-linear-algebra",
          itemId: "11111111-1111-1111-1111-111111111111",
        }),
      /Unknown workspace item/,
    );
    const source = await host.call<{ item: { kind: string }; content: string | null }>(
      "workspace.readItem",
      { pathId: "path-linear-algebra", itemId: store.workspace("path-linear-algebra")!.items[0]!.id },
    );
    assert.equal(source.item.kind, "source");
    assert.equal(source.content, null, "source items reference the global store and carry no file");
  } finally {
    close(host, directory);
  }
});

test("workspace.updateItemMeta is learner filing only: title, caption and links", async () => {
  const { host, directory } = hostWithPath();
  try {
    await host.call("workspace.saveNote", {
      pathId: "path-linear-algebra",
      nodeId: "n-skill",
      title: "Feynman notes on vector spaces",
      markdown: "body",
    });
    const store = openLearningPathStore(directory);
    const itemId = store.workspace("path-linear-algebra")!.items[0]!.id;

    const relabeled = await host.call<{ item: { title: string; caption?: string } }>(
      "workspace.updateItemMeta",
      { pathId: "path-linear-algebra", itemId, title: "Renamed notes", caption: "From Tuesday" },
    );
    assert.equal(relabeled.item.title, "Renamed notes");
    assert.equal(relabeled.item.caption, "From Tuesday");

    const cleared = await host.call<{ item: { caption?: string } }>("workspace.updateItemMeta", {
      pathId: "path-linear-algebra",
      itemId,
      caption: null,
    });
    assert.equal(cleared.item.caption, undefined, "an explicit null caption clears it");

    const unlinked = await host.call<{ item: { links: unknown[] } }>("workspace.updateItemMeta", {
      pathId: "path-linear-algebra",
      itemId,
      links: [],
    });
    assert.deepEqual(unlinked.item.links, []);

    await assert.rejects(
      () =>
        host.call("workspace.updateItemMeta", {
          pathId: "path-linear-algebra",
          itemId,
          links: [{ to: "n-missing", rel: "informs" }],
        }),
      /unknown node id "n-missing"/,
    );
    await assert.rejects(
      () => host.call("workspace.updateItemMeta", { pathId: "path-linear-algebra", itemId }),
      /needs title, caption or links/,
    );
    await assert.rejects(
      () =>
        host.call("workspace.updateItemMeta", {
          pathId: "path-linear-algebra",
          itemId,
          progression: "consolidated",
        }),
      /needs title, caption or links/,
      "non-filing keys change nothing and are refused",
    );

    const stored = openLearningPathStore(directory).workspace("path-linear-algebra")!.items[0]!;
    assert.equal(stored.title, "Renamed notes");
    assert.deepEqual(stored.links, []);
  } finally {
    close(host, directory);
  }
});

test("workspace.deleteItem removes the item and its content file exactly once", async () => {
  const { host, directory } = hostWithPath();
  try {
    await host.call("workspace.saveNote", {
      pathId: "path-linear-algebra",
      title: "Feynman notes on vector spaces",
      markdown: "body",
    });
    const itemId = openLearningPathStore(directory).workspace("path-linear-algebra")!.items[0]!.id;

    const first = await host.call<{ deleted: boolean }>("workspace.deleteItem", {
      pathId: "path-linear-algebra",
      itemId,
    });
    assert.equal(first.deleted, true);
    assert.ok(
      host.events.some(
        (event) => event.topic === EVENT_WORKSPACE_CHANGED && (event.data as { deleted?: boolean }).deleted === true,
      ),
    );

    const second = await host.call<{ deleted: boolean }>("workspace.deleteItem", {
      pathId: "path-linear-algebra",
      itemId,
    });
    assert.equal(second.deleted, false, "deleting twice is a no-op");

    assert.equal(openLearningPathStore(directory).workspace("path-linear-algebra")?.items.length, 0);
    const filesDirectory = path.join(
      directory,
      WORKSPACES_DIRECTORY,
      "path-linear-algebra",
      WORKSPACE_FILES_DIRECTORY,
    );
    assert.deepEqual(fs.readdirSync(filesDirectory), [], "the content file goes with the item");
  } finally {
    close(host, directory);
  }
});

test("no agent tool writes learner workspace items; agents only read", async () => {
  const { host, directory } = hostWithPath();
  try {
    // The Architect definition is registered lazily on the first create.
    await host.call("architect.create", {});
    const architectTools = [...host.definitions.get("path-architect")!.tools ?? []].map(
      (tool) => tool.name,
    );
    assert.deepEqual(
      architectTools.filter((name) => name.startsWith("workspace_")),
      [],
      "the Architect definition carries no workspace write tool",
    );
    const nativeToolNames = host
      .toolContributions.flatMap((contribution) => contribution.agents)
      .length > 0
      ? (await import("../src/tool-names.ts")).LEARNING_PATH_TOOL_NAMES
      : [];
    // Workspace writes: agents never delete anything, and the one save tool
    // writes only the session's own session_artifact item (provenance
    // session:<chatId>, asserted behaviourally in native-bridge.test.ts).
    // Learner items stay learner-owned.
    assert.ok(
      nativeToolNames.every((name) => !name.includes("delete")),
      "native tools stay read-only for learner items",
    );
    assert.ok(
      nativeToolNames.filter((name) => name.includes("save")).every(
        (name) => name === "learning_path_save_artifact",
      ),
      "the only workspace write is the session's own session_artifact item",
    );
  } finally {
    close(host, directory);
  }
});

test("workspace.saveSource stores the document once and files it as a node-linked source item", async () => {
  const { host, directory } = hostWithPath();
  try {
    const markdown = "# A paper\n\nConverted document text.";
    const saved = await host.call<{
      item: { id: string; kind: string; title: string; sourceId: string; addedBy: string; links: { to: string; rel: string }[] };
      reference: { sourceId: string; name: string };
      deduplicated: boolean;
      alreadyFiled: boolean;
    }>("workspace.saveSource", {
      pathId: "path-linear-algebra",
      name: "paper.pdf",
      markdown,
      links: [{ to: "n-skill", rel: "grounds" }],
    });
    assert.equal(saved.item.kind, "source");
    assert.equal(saved.item.title, "paper.pdf", "the title defaults to the document name");
    assert.equal(saved.item.sourceId, saved.reference.sourceId, "the manifest references the global source");
    assert.equal(saved.item.addedBy, "learner");
    assert.deepEqual(saved.item.links, [{ to: "n-skill", rel: "grounds" }]);
    assert.equal(saved.alreadyFiled, false);

    // sources/ stays the single global store: the document's bytes live there,
    // and the workspace carries no copy — a source item has no content file.
    assert.equal(
      fs.readFileSync(path.join(directory, "sources", `${saved.reference.sourceId}.md`), "utf8"),
      markdown,
    );
    assert.ok(
      !fs.existsSync(path.join(directory, WORKSPACES_DIRECTORY, "path-linear-algebra", WORKSPACE_FILES_DIRECTORY, `${saved.item.id}.md`)),
      "a source item references the library; nothing is copied under workspaces/",
    );
    const read = await host.call<{ content: string | null }>("workspace.readItem", {
      pathId: "path-linear-algebra",
      itemId: saved.item.id,
    });
    assert.equal(read.content, null, "the workspace read returns no file for a source item");

    assert.ok(host.events.some((event) => event.topic === "sources-changed"));
    assert.ok(host.events.some((event) => event.topic === EVENT_WORKSPACE_CHANGED));

    const reopened = openLearningPathStore(directory);
    const items = reopened.workspace("path-linear-algebra")?.items ?? [];
    assert.equal(items.length, 1);
    assert.equal(items[0]?.sourceId, saved.reference.sourceId);
  } finally {
    close(host, directory);
  }
});

test("workspace.saveSource deduplicates: a re-filed document returns the existing item", async () => {
  const { host, directory } = hostWithPath();
  try {
    const markdown = "# Same bytes\n\nIdentical conversion.";
    const first = await host.call<{ item: { id: string }; reference: { sourceId: string } }>(
      "workspace.saveSource",
      { pathId: "path-linear-algebra", name: "first.pdf", markdown, links: [{ to: "n-skill", rel: "grounds" }] },
    );
    const second = await host.call<{
      item: { id: string; title: string; links: { to: string; rel: string }[] };
      reference: { sourceId: string };
      deduplicated: boolean;
      alreadyFiled: boolean;
    }>("workspace.saveSource", {
      pathId: "path-linear-algebra",
      name: "renamed-copy.pdf",
      markdown,
      links: [],
    });
    assert.equal(second.item.id, first.item.id, "the same document does not file twice");
    assert.equal(second.item.title, "first.pdf", "the original filing, including its links, stands");
    assert.deepEqual(second.item.links, [{ to: "n-skill", rel: "grounds" }]);
    assert.equal(second.reference.sourceId, first.reference.sourceId, "hash dedup in sources/ holds");
    assert.equal(second.deduplicated, true);
    assert.equal(second.alreadyFiled, true);

    const reopened = openLearningPathStore(directory);
    assert.equal(reopened.workspace("path-linear-algebra")?.items.length, 1);
    assert.equal(reopened.sources().length, 1, "one document, one stored source");

    // Link edits go through the learner's existing filing surface.
    await host.call("workspace.updateItemMeta", {
      pathId: "path-linear-algebra",
      itemId: first.item.id,
      links: [{ to: "n-holistic", rel: "informs" }],
    });
    assert.equal(
      openLearningPathStore(directory).workspace("path-linear-algebra")?.items[0]?.links[0]?.to,
      "n-holistic",
    );
  } finally {
    close(host, directory);
  }
});

test("workspace.saveSource rejects an unknown path and lets the store validate links", async () => {
  const { host, directory } = hostWithPath();
  try {
    await assert.rejects(
      host.call("workspace.saveSource", { pathId: "path-missing", name: "x.pdf", markdown: "text" }),
      /Unknown path/,
    );
    await assert.rejects(
      host.call("workspace.saveSource", {
        pathId: "path-linear-algebra",
        name: "x.pdf",
        markdown: "text",
        links: [{ to: "n-nothing", rel: "grounds" }],
      }),
      /link/,
      "links resolve against real node ids",
    );
    await assert.rejects(
      host.call("workspace.saveSource", {
        pathId: "path-linear-algebra",
        name: "x.pdf",
        markdown: "text",
        links: "not-an-array",
      }),
      /links must be an array/,
    );
    await assert.rejects(
      host.call("workspace.saveSource", { pathId: "path-linear-algebra", name: "", markdown: "text" }),
      /name must not be blank/,
    );
    const reopened = openLearningPathStore(directory);
    assert.equal(reopened.workspace("path-linear-algebra"), null, "a rejected save writes nothing");
  } finally {
    close(host, directory);
  }
});

test("workspace.openDirectory reveals the path's workspace folder, materializing it on demand", async () => {
  const { host, directory } = hostWithPath();
  try {
    const result = await host.call<{ directory: string }>("workspace.openDirectory", {
      pathId: "path-linear-algebra",
    });
    assert.ok(
      result.directory.startsWith(path.join(directory, WORKSPACES_DIRECTORY)),
      "the revealed folder is the path's own workspace directory",
    );
    assert.equal(fs.lstatSync(result.directory).isDirectory(), true, "an empty workspace materializes on demand");
    assert.deepEqual(host.openedDirectories, [result.directory], "the opener runs exactly once for the right folder");

    await assert.rejects(
      host.call("workspace.openDirectory", { pathId: "path-missing" }),
      /Unknown path: path-missing/,
      "an unknown path opens nothing",
    );
    assert.equal(host.openedDirectories.length, 1, "a refused path never reaches the opener");
  } finally {
    close(host, directory);
  }
});

test("workspace.openItem hands the item's raw content file to the OS application the learner picks", async () => {
  const { host, directory } = hostWithPath();
  try {
    const saved = await host.call<{ item: { id: string } }>("workspace.saveNote", {
      pathId: "path-linear-algebra",
      title: "Feynman notes on vector spaces",
      markdown: "the learner's own writing",
    });

    // The editor gets the file as stored — frontmatter and body — so an
    // external edit stays resyncable; the OS resolves the application.
    const result = await host.call<{ file: string }>("workspace.openItem", {
      pathId: "path-linear-algebra",
      itemId: saved.item.id,
    });
    assert.ok(
      result.file.startsWith(path.join(directory, WORKSPACES_DIRECTORY)),
      "the opened file is the item's own content file",
    );
    const raw = fs.readFileSync(result.file, "utf8");
    assert.match(raw, /^---/, "the raw file keeps its frontmatter for the editor");
    assert.ok(raw.includes("the learner's own writing"));
    assert.deepEqual(host.openedFiles, [result.file], "the opener runs exactly once for the right file");

    // Refusals never reach the opener: unknown path, unknown item, source.
    await assert.rejects(
      host.call("workspace.openItem", { pathId: "path-missing", itemId: saved.item.id }),
      /Unknown path: path-missing/,
    );
    await assert.rejects(
      host.call("workspace.openItem", { pathId: "path-linear-algebra", itemId: UNKNOWN_ITEM_ID }),
      /carries no content file to open/,
    );
    const filed = await host.call<{ item: { id: string } }>("workspace.saveSource", {
      pathId: "path-linear-algebra",
      name: "axioms.md",
      markdown: "# axioms",
    });
    await assert.rejects(
      host.call("workspace.openItem", { pathId: "path-linear-algebra", itemId: filed.item.id }),
      /carries no content file to open/,
      "a source references the global library and owns no file to open",
    );
    assert.equal(host.openedFiles.length, 1, "refused calls never reach the opener");
  } finally {
    close(host, directory);
  }
});

test("workspace.resync re-hydrates the manifest from files the learner edited externally", async () => {
  const { host, directory } = hostWithPath();
  try {
    const saved = await host.call<{ item: { id: string } }>("workspace.saveNote", {
      pathId: "path-linear-algebra",
      title: "Lecture 7 questions",
      markdown: "original body",
      links: [{ to: "n-concept", rel: "informs" }],
    });

    // The learner rewrites the file in their own editor while LearnHarness
    // is open: a new title, a filing under a second node, a body edit.
    const filesDir = path.join(directory, WORKSPACES_DIRECTORY, "path-linear-algebra", WORKSPACE_FILES_DIRECTORY);
    const externalId = "44444444-4444-4444-4444-444444444444";
    fs.writeFileSync(path.join(filesDir, `dsa-open-questions-${externalId}.md`), [
      "---",
      `id: "${externalId}"`,
      "kind: note",
      'title: "DSA open questions after lecture 7"',
      'addedAt: "2026-03-01T10:00:00.000Z"',
      "links:",
      "  - to: " + "n-skill",
      "    rel: informs",
      "---",
      "Do DAGs admit a shortest-path proof?",
      "",
    ].join("\n"));
    const edited = fs.readdirSync(filesDir).find((name) => name.endsWith(`${saved.item.id}.md`))!;
    fs.writeFileSync(
      path.join(filesDir, edited),
      fs.readFileSync(path.join(filesDir, edited), "utf8").replace("original body", "rewritten mid-session"),
    );

    const resynced = await host.call<{ workspace: { items: unknown[] }; changed: boolean }>("workspace.resync", {
      pathId: "path-linear-algebra",
    });
    assert.equal(resynced.changed, true);
    assert.equal(resynced.workspace.items.length, 2, "the external file materialized as an item");
    assert.ok(host.events.some((event) => event.topic === EVENT_WORKSPACE_CHANGED), "the change is announced");

    const titles = await host.call<{ workspace: { items: { id: string; title: string; addedBy: string }[] } }>(
      "workspace.resync",
      { pathId: "path-linear-algebra" },
    );
    const materialized = titles.workspace.items.find((item) => item.id === externalId)!;
    assert.equal(materialized.title, "DSA open questions after lecture 7");
    assert.equal(materialized.addedBy, "learner");

    // The in-app note's body edit lands too, and a quiet resync writes nothing.
    const read = await host.call<{ content: string | null }>("workspace.readItem", {
      pathId: "path-linear-algebra",
      itemId: saved.item.id,
    });
    assert.equal(read.content, "rewritten mid-session");
    const before = host.events.length;
    const quiet = await host.call<{ changed: boolean }>("workspace.resync", { pathId: "path-linear-algebra" });
    assert.equal(quiet.changed, false);
    assert.equal(host.events.length, before, "an unchanged resync emits nothing");

    await host.call("paths.delete", { pathId: "path-linear-algebra" });
    assert.equal(fs.existsSync(path.join(directory, WORKSPACES_DIRECTORY, "path-linear-algebra")), false);
  } finally {
    close(host, directory);
  }
});
