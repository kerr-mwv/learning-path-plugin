/** Path Hub workspace ledger UI tests.
 *
 * The ledger is the Workspace tab of the floating details window — the same
 * window, the same treatment as the node details (one floating pane, one set
 * of windowing affordances; no separate surface stacked underneath anything).
 * The list itself is the host tree (`mountTree`): rows are controlled props
 * — title in the lead column, kind/filing/actions as columns — and an
 * expanded row previews its Markdown body in place through a lazy
 * `workspace.readItem` read. The guardrail sweep stays: no unread counts or
 * "new" badges anywhere in the mounted hub. The in-memory backend in
 * view-host backs the workspace RPCs; nothing touches storage.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PluginTreeRow } from "learnharness-plugin-api";
import { mountPathHub } from "../src/view/path-hub.ts";
import { buildChildSessionBrief } from "../src/framework.ts";
import { clearPathHubTarget } from "../src/session-navigation.ts";
import type { NativeSessionHost } from "../src/native-session-host.ts";
import type { WorkspaceManifest } from "../src/domain.ts";
import { ITEM_ID, ITEM_ID_2, makeItem, makePath } from "./fixtures.ts";
import { createViewFixture, fire, selectRoadmapCard } from "./view-host.ts";
import type { MountRecord, ViewFixture } from "./view-host.ts";

function fakeHost(): NativeSessionHost {
  return {
    async create() {
      throw new Error("not used");
    },
    stageOpeningPrompt() {
      return true;
    },
    clearOpeningPrompt() {},
  } as unknown as NativeSessionHost;
}

async function mounted(fixture: ViewFixture): Promise<HTMLElement> {
  mountPathHub(fixture.context, fixture.root, fixture.context.signal, { sessionHost: fakeHost() });
  await fixture.flush();
  await fixture.flush();
  return fixture.root;
}

function button(fixture: ViewFixture, label: string) {
  const found = fixture.all("mountButton").filter((record) => record.props.label === label);
  assert.ok(found.length > 0, `Missing button ${label}`);
  return found;
}

/** Find a native DOM `<button>` inside a parent: by its visible text, or by
 * its aria-label when the button is icon-only (the label stays the
 * accessible name, the icon carries the look). */
function nativeButtonIn(parent: HTMLElement, label: string): HTMLButtonElement {
  const found = [...parent.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
  );
  assert.ok(found, `Missing native button ${label}`);
  return found!;
}

interface WorkspaceLink {
  readonly to: string;
  readonly rel: string;
}

interface WorkspaceCall {
  readonly name: string;
  readonly input: {
    pathId?: string;
    itemId?: string;
    links?: WorkspaceLink[];
    nodeId?: string;
    title?: string;
    markdown?: string;
  };
}

function calls(fixture: ViewFixture, name: string): WorkspaceCall[] {
  return fixture.calls.filter((call): call is WorkspaceCall => call.name === name);
}

function lastCall(fixture: ViewFixture, name: string): WorkspaceCall | undefined {
  return calls(fixture, name).at(-1);
}

function inspector(root: HTMLElement): HTMLElement {
  const element = root.querySelector<HTMLElement>(".lp-inspector");
  assert.ok(element);
  return element;
}

/** The floating window that carries the node details and the ledger tab. */
function inspectorPane(root: HTMLElement): HTMLElement {
  const element = root.querySelector<HTMLElement>(".lp-inspector-pane");
  assert.ok(element, "the floating details window is rendered");
  return element;
}

/** The window's tab buttons: native DOM, not host widgets. */
function inspectorTab(root: HTMLElement, match: RegExp): HTMLButtonElement {
  const found = [...inspectorPane(root).querySelectorAll<HTMLButtonElement>(".lp-tab")].find(
    (tab) => match.test(tab.textContent ?? ""),
  );
  assert.ok(found, `Missing inspector tab ${match}`);
  return found!;
}

function workspaceBody(root: HTMLElement): HTMLElement {
  const element = root.querySelector<HTMLElement>(".lp-workspace-body");
  assert.ok(element, "the ledger tab's body is rendered");
  return element;
}

/** The live ledger tree record: the host tree owns the rows, so tests read
 * controlled row props (title, cells, disclosure, children), not row DOM. */
function treeRecord(fixture: ViewFixture): MountRecord {
  return fixture.findLast("mountTree");
}

function ledgerRows(fixture: ViewFixture): PluginTreeRow[] {
  return treeRecord(fixture).props.rows as PluginTreeRow[];
}

/** Every learner-visible string in the ledger: tab DOM text plus the tree's
 * controlled row text, so guardrail sweeps cover both. */
function ledgerText(fixture: ViewFixture): string {
  const parts: string[] = [workspaceBody(fixture.root).textContent ?? ""];
  for (const row of ledgerRows(fixture)) {
    if (typeof row.content === "string") parts.push(row.content);
    for (const cell of Object.values(row.cells ?? {})) {
      if (typeof cell === "string") parts.push(cell);
    }
    for (const child of row.children ?? []) {
      if (typeof child.content === "string") parts.push(child.content);
    }
  }
  return parts.join("\n");
}

/** The row's kind reads as an icon; the hover tooltip (title) carries the
 * word, so nothing about the kind is hidden from hover or a screen reader. */
function kindCellOf(row: PluginTreeRow): HTMLElement {
  const cell = row.cells?.kind;
  assert.ok(cell && typeof cell !== "string", "the row shows the item's kind as its icon");
  return cell as HTMLElement;
}

function filedTextOf(row: PluginTreeRow): string {
  return String(row.cells?.filed ?? "");
}

/** Expand one row's in-place preview and let the lazy read land. */
async function expandRow(fixture: ViewFixture, index: number): Promise<void> {
  const row = ledgerRows(fixture)[index]!;
  assert.ok(row.disclosure, "content-bearing rows carry a preview disclosure");
  await row.disclosure!.onChange(true);
  await fixture.flush();
  await fixture.flush();
}

/** Switch the floating window to its Workspace ledger tab. The ledger is a
 * view of the window the learner already has open, one tab click away. */
async function openLedgerTab(fixture: ViewFixture): Promise<void> {
  const tab = inspectorTab(fixture.root, /^Workspace ledger/);
  tab.click();
  await fixture.flush();
  const body = workspaceBody(fixture.root);
  assert.equal(body.hidden, false, "the workspace tab shows the ledger");
  assert.ok(
    inspectorPane(fixture.root).contains(body),
    "the ledger lives inside the floating details window",
  );
}

const initialItem = (overrides = {}) =>
  makeItem({ links: [{ to: "n-skill", rel: "informs" }], ...overrides });

test("the window carries a details tab and a workspace tab; switching and closing behave", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [{ item: initialItem(), content: "body" }],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();

    // The floating window opens on the details tab; the ledger is one tab
    // click away, with the honest item count carried in the tab's own label.
    const pane = inspectorPane(fixture.root);
    assert.equal(pane.hidden, false, "selecting a node opens the floating window");
    const detailsTab = inspectorTab(fixture.root, /^Node details/);
    assert.equal(detailsTab.getAttribute("aria-pressed"), "true", "details is the default tab");
    assert.equal(workspaceBody(fixture.root).hidden, true, "the ledger starts hidden");
    assert.match(inspectorTab(fixture.root, /^Workspace ledger/).textContent ?? "", /1 item/);

    await openLedgerTab(fixture);
    assert.equal(
      inspectorTab(fixture.root, /^Node details/).getAttribute("aria-pressed"),
      "false",
      "the details tab stands down",
    );
    assert.equal(ledgerRows(fixture).length, 1, "the ledger tab carries the tree");
    assert.match(workspaceBody(fixture.root).textContent ?? "", /1 item/);

    // The header's affordances are icon-only (+, folder): the label stays the
    // accessible name and the hover title carries the word.
    const addNote = nativeButtonIn(fixture.root, "Add Note");
    assert.equal(addNote.getAttribute("aria-label"), "Add Note");
    assert.equal(addNote.textContent, "", "Add Note reads as a + glyph");
    assert.ok(addNote.querySelector("svg"), "the + is drawn as SVG");
    const openFolder = nativeButtonIn(fixture.root, "Open folder");
    assert.equal(openFolder.getAttribute("aria-label"), "Open folder");
    assert.ok(openFolder.querySelector("svg"), "the folder is drawn as SVG");
    assert.equal(
      nativeButtonIn(fixture.root, "Select from computer…").textContent?.trim(),
      "Select from computer…",
      "the filing strip's picker keeps its words",
    );

    // Switching back shows the node details again, without losing anything.
    inspectorTab(fixture.root, /^Node details/).click();
    await fixture.flush();
    assert.equal(workspaceBody(fixture.root).hidden, true, "the ledger tab hides");
    assert.ok(inspector(fixture.root).dataset.nodeId === "n-skill", "the details are back in view");

    // The window's own Close dismisses it; reopening starts on details again.
    await openLedgerTab(fixture);
    const close = button(fixture, "Close").filter((record) => pane.contains(record.container))[0]!;
    await close.props.onClick();
    await fixture.flush();
    assert.equal(pane.hidden, true, "Close dismisses the whole window");
    assert.equal(
      inspectorTab(fixture.root, /^Node details/).getAttribute("aria-pressed"),
      "true",
      "a closed window resets to the details tab",
    );

    selectRoadmapCard(fixture.root, "n-concept");
    await fixture.flush();
    assert.equal(pane.hidden, false);
    assert.equal(workspaceBody(fixture.root).hidden, true, "the details tab is the fresh default");
    await openLedgerTab(fixture);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("the tree lists items newest last with honest counts and no unread or new state", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [
      { item: initialItem(), content: "older note" },
      {
        item: makeItem({
          id: "3f2504e0-4f89-11d3-9a0c-0305e82c3302",
          title: "Later margin note",
          addedAt: "2026-02-01T00:00:00.000Z",
          links: [],
        }),
        content: "newer note",
      },
    ],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openLedgerTab(fixture);

    const rows = ledgerRows(fixture);
    assert.deepEqual(
      rows.map((row) => row.key),
      [ITEM_ID, "3f2504e0-4f89-11d3-9a0c-0305e82c3302"],
      "oldest first, newest last",
    );
    assert.equal(rows[0]!.content, "Feynman notes on vector spaces");
    assert.equal(kindCellOf(rows[0]!).title, "Note", "hovering the kind icon carries the word");
    assert.match(filedTextOf(rows[0]!), /linked: Node n-skill \(informs\)/);
    assert.match(filedTextOf(rows[1]!), /unlinked/);
    assert.match(workspaceBody(fixture.root).textContent ?? "", /2 items/);
    assert.match(
      inspectorTab(fixture.root, /^Workspace ledger/).textContent ?? "",
      /2 items/,
      "the tab's label counts honestly too",
    );

    // The guardrail sweep runs over the ledger's DOM text and the tree's
    // controlled row text, and over every mounted badge anywhere.
    const text = ledgerText(fixture);
    assert.doesNotMatch(text, /unread/i);
    assert.doesNotMatch(text, /\bnew\b/i, "no 'new' badges anywhere in the ledger");
    const badges = fixture
      .all("mountBadge")
      .filter((record) => /unread|new/i.test(String(record.props.text ?? "")));
    assert.deepEqual(badges, [], "no unread or new badge is mounted for workspace state");
    assert.ok(fire, "fire helper stays imported for parity with sibling tests");

    // Listing is metadata only: no content read has happened yet.
    assert.equal(calls(fixture, "workspace.readItem").length, 0);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("item content loads on demand: readItem fires only when a row expands", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [{ item: initialItem(), content: "# Verbatim body\n\n- kept  as  typed\n" }],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openLedgerTab(fixture);

    // Mounting the hub and listing the ledger fetched no content at all.
    assert.equal(calls(fixture, "workspace.readItem").length, 0, "no eager content reads");
    assert.equal(fixture.all("mountMarkdown").length, 0, "no markdown mounted before expanding");

    await expandRow(fixture, 0);

    const read = lastCall(fixture, "workspace.readItem");
    assert.ok(read, "the content is read on demand");
    assert.equal(read!.input.itemId, ITEM_ID);

    const expanded = ledgerRows(fixture)[0]!;
    assert.equal(expanded.disclosure!.expanded, true, "the row stays expanded");
    assert.ok(expanded.children, "the preview row sits under its item");
    assert.equal(expanded.children![0]!.key, `${ITEM_ID}-preview`);
    const markdown = fixture.all("mountMarkdown").at(-1);
    assert.ok(markdown, "the preview renders the content read-only");
    assert.equal(markdown!.props.text, "# Verbatim body\n\n- kept  as  typed\n");

    // Collapsing is the way back: no second read, and the row is whole again.
    await expanded.disclosure!.onChange(false);
    await fixture.flush();
    assert.equal(calls(fixture, "workspace.readItem").length, 1, "collapsing does not re-read");
    assert.equal(ledgerRows(fixture)[0]!.children, undefined, "the preview row is gone");
    assert.equal(ledgerRows(fixture)[0]!.disclosure!.expanded, false);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("the preview is read-only: no composer, no editable surface for item content", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [{ item: initialItem(), content: "body" }],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openLedgerTab(fixture);
    await expandRow(fixture, 0);

    const composerInWindow = fixture
      .all("mountStandardComposer")
      .some((record) => inspectorPane(fixture.root).contains(record.container));
    assert.equal(composerInWindow, false, "no composer is mounted inside the window");
    // The filing strip's hidden native picker is an affordance, not an editable
    // surface for item content: only text-entry fields make the viewer editable.
    assert.equal(
      workspaceBody(fixture.root).querySelector("textarea, input:not([type='checkbox']):not([type='file'])"),
      null,
      "the preview carries no editable field",
    );
    const picker = workspaceBody(fixture.root).querySelector<HTMLElement>("input[type='file']");
    assert.ok(picker, "the filing strip carries its native file picker");
    assert.equal(picker!.hidden, true, "the picker is hidden chrome, never editable content");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("a source item references the sources store; its preview reads nothing", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [
      {
        item: makeItem({
          kind: "source",
          title: "A referenced paper",
          sourceId: "source-1",
          links: [{ to: "n-skill", rel: "grounds" }],
        }),
        content: "",
      },
    ],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openLedgerTab(fixture);
    const rows = ledgerRows(fixture);
    assert.equal(kindCellOf(rows[0]!).title, "Source", "hovering the kind icon carries the word");
    await expandRow(fixture, 0);
    assert.equal(
      calls(fixture, "workspace.readItem").length,
      0,
      "a source references the library; its preview fetches nothing",
    );
    const preview = ledgerRows(fixture)[0]!.children![0]!;
    assert.match(String(preview.content), /source library/, "the preview says where the text lives");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("session artifacts render in the tree with their originating session", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [
      {
        item: makeItem({
          kind: "session_artifact",
          title: "Saved relational map",
          addedBy: "session:chat-map-1",
          links: [{ to: "n-skill", rel: "produced_by" }],
        }),
        content: "# Map of the earlier session",
      },
    ],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openLedgerTab(fixture);

    const row = ledgerRows(fixture)[0]!;
    assert.equal(row.content, "Saved relational map", "the saved artifact appears in the ledger");
    assert.equal(kindCellOf(row).title, "Session artifact", "hovering the kind icon carries the word");
    assert.match(filedTextOf(row), /saved by session chat-map-1/, "the row carries its provenance");

    await expandRow(fixture, 0);
    const markdown = fixture.all("mountMarkdown").at(-1);
    assert.ok(markdown, "the saved artifact previews inside the tree");
    assert.equal(markdown!.props.text, "# Map of the earlier session");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("Add Note files an unlinked note or links it to several nodes at once", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-concept");
    await fixture.flush();
    await openLedgerTab(fixture);
    assert.match(workspaceBody(fixture.root).textContent ?? "", /No workspace items yet/);

    nativeButtonIn(workspaceBody(fixture.root), "Add Note").click();
    await fixture.flush();
    const dialog = fixture.find("openDialog");
    assert.equal(dialog.props.title, "Add Workspace Note");
    const content = dialog.contentContainer!;

    const titleInput = content.querySelector<HTMLInputElement>("input[aria-label='Note title']")!;
    const bodyInput = content.querySelector<HTMLTextAreaElement>("textarea[aria-label='Note content']")!;
    titleInput.value = "Feynman notes on vector spaces";
    bodyInput.value = "# Written in my own editor\n\n- kept  as  typed\n";

    // The node picker defaults to the inspected node only.
    const checkboxes = [...content.querySelectorAll<HTMLInputElement>(".lp-workspace-picker input[type='checkbox']")];
    assert.equal(checkboxes.length, 6, "every node of the path is pickable");
    const checkedNow = checkboxes.filter((input) => input.checked).map((input) => input.value);
    assert.deepEqual(checkedNow, ["n-concept"]);

    // Link to three nodes at once.
    for (const value of ["n-skill", "n-holistic"]) {
      const input = checkboxes.find((candidate) => candidate.value === value)!;
      input.checked = true;
    }

    await button(fixture, "Save Note")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const saved = lastCall(fixture, "workspace.saveNote");
    assert.ok(saved);
    assert.equal(saved.input.markdown, bodyInput.value, "the markdown is passed verbatim");
    assert.deepEqual(
      [...(saved.input.links ?? [])].sort((a, b) => a.to.localeCompare(b.to)),
      [
        { to: "n-concept", rel: "informs" },
        { to: "n-holistic", rel: "informs" },
        { to: "n-skill", rel: "informs" },
      ],
      "one save files the note under several nodes",
    );

    const row = ledgerRows(fixture).at(-1)!;
    assert.equal(row.content, "Feynman notes on vector spaces", "the saved note appears in the ledger");
    assert.match(filedTextOf(row), /Node n-skill \(informs\)/);
    assert.match(filedTextOf(row), /Node n-concept \(informs\)/);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("a note created with no node checked is unlinked", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-concept");
    await fixture.flush();
    await openLedgerTab(fixture);
    nativeButtonIn(workspaceBody(fixture.root), "Add Note").click();
    await fixture.flush();
    const content = fixture.find("openDialog").contentContainer!;
    content.querySelector<HTMLInputElement>("input[aria-label='Note title']")!.value = "Loose scratchpad";
    content.querySelector<HTMLTextAreaElement>("textarea[aria-label='Note content']")!.value = "body";
    const inspected = [...content.querySelectorAll<HTMLInputElement>(".lp-workspace-picker input[type='checkbox']")].find(
      (input) => input.value === "n-concept",
    )!;
    inspected.checked = false;

    await button(fixture, "Save Note")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const saved = lastCall(fixture, "workspace.saveNote");
    assert.ok(saved);
    assert.deepEqual(saved.input.links, [], "no checked node means an unlinked note");
    assert.match(filedTextOf(ledgerRows(fixture).at(-1)!), /unlinked/);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("the Links dialog files one item under several nodes and preserves relations", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [
      { item: makeItem({ links: [{ to: "n-skill", rel: "produced_by" }] }), content: "body" },
    ],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-concept");
    await fixture.flush();
    await openLedgerTab(fixture);

    // The actions cell is plugin DOM mounted by the host tree: the row's
    // Links… opens the filing dialog.
    nativeButtonIn(workspaceBody(fixture.root), "Links…").click();
    await fixture.flush();
    const dialog = fixture.findLast("openDialog");
    assert.match(dialog.props.title, /Links — Feynman notes/);
    const checkboxes = [...dialog.contentContainer!.querySelectorAll<HTMLInputElement>(
      ".lp-workspace-picker input[type='checkbox']",
    )];
    assert.deepEqual(
      checkboxes.filter((input) => input.checked).map((input) => input.value),
      ["n-skill"],
      "the item's existing links start checked",
    );

    // File the item under two more nodes as well.
    for (const value of ["n-concept", "n-holistic"]) {
      checkboxes.find((candidate) => candidate.value === value)!.checked = true;
    }
    await button(fixture, "Save Links")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const saved = lastCall(fixture, "workspace.updateItemMeta");
    assert.ok(saved);
    assert.equal(saved.input.itemId, ITEM_ID);
    assert.deepEqual(
      [...(saved.input.links ?? [])].sort((a, b) => a.to.localeCompare(b.to)),
      [
        { to: "n-concept", rel: "informs" },
        { to: "n-holistic", rel: "informs" },
        { to: "n-skill", rel: "produced_by" },
      ],
      "new links file rel informs; existing relations are preserved",
    );

    const row = ledgerRows(fixture)[0]!;
    assert.match(filedTextOf(row), /Node n-skill \(produced_by\)/);
    assert.match(filedTextOf(row), /Node n-concept \(informs\)/);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("unlinking through the picker removes only the unchecked node's link", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [
      {
        item: makeItem({
          links: [
            { to: "n-skill", rel: "informs" },
            { to: "n-concept", rel: "informs" },
          ],
        }),
        content: "body",
      },
    ],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openLedgerTab(fixture);

    nativeButtonIn(workspaceBody(fixture.root), "Links…").click();
    await fixture.flush();
    const dialog = fixture.findLast("openDialog");
    const checkboxes = [...dialog.contentContainer!.querySelectorAll<HTMLInputElement>(
      ".lp-workspace-picker input[type='checkbox']",
    )];
    checkboxes.find((candidate) => candidate.value === "n-concept")!.checked = false;

    await button(fixture, "Save Links")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    const saved = lastCall(fixture, "workspace.updateItemMeta");
    assert.deepEqual(
      [...(saved!.input.links ?? [])].sort((a, b) => a.to.localeCompare(b.to)),
      [{ to: "n-skill", rel: "informs" }],
    );
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("a note linked to three nodes appears in each node's session brief", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openLedgerTab(fixture);

    nativeButtonIn(workspaceBody(fixture.root), "Add Note").click();
    await fixture.flush();
    const content = fixture.find("openDialog").contentContainer!;
    content.querySelector<HTMLInputElement>("input[aria-label='Note title']")!.value = "Feynman notes on vector spaces";
    content.querySelector<HTMLTextAreaElement>("textarea[aria-label='Note content']")!.value = "body";
    for (const input of content.querySelectorAll<HTMLInputElement>(".lp-workspace-picker input[type='checkbox']")) {
      input.checked = ["n-skill", "n-concept", "n-holistic"].includes(input.value);
    }
    await button(fixture, "Save Note")[0]!.props.onClick();
    await fixture.flush();
    await fixture.flush();

    // Read the manifest the way the hub did after the save.
    const manifest = await fixture.context.call<{ workspace: WorkspaceManifest | null }>(
      "workspace.list",
      { pathId: path.id },
    );
    assert.equal(manifest.workspace?.items.length, 1);
    for (const nodeId of ["n-skill", "n-concept", "n-holistic"]) {
      const brief = buildChildSessionBrief({
        path,
        nodeId,
        kind: "teaching",
        settings: fixture.settings,
        workspace: manifest.workspace,
      });
      assert.match(brief.text, /Feynman notes on vector spaces/, `the brief for ${nodeId} lists the note`);
    }
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("Delete from the tree removes the item through the learner-filing RPC", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [{ item: initialItem(), content: "body" }],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await fixture.flush();
    await openLedgerTab(fixture);

    nativeButtonIn(workspaceBody(fixture.root), "Delete").click();
    await fixture.flush();
    await fixture.flush();
    const deleted = lastCall(fixture, "workspace.deleteItem");
    assert.ok(deleted);
    assert.equal(deleted.input.itemId, ITEM_ID);
    assert.match(workspaceBody(fixture.root).textContent ?? "", /No workspace items yet/);
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

/** A drop event carrying files, the way a real DragEvent arrives. */
function dropEvent(document: Document, files: File[], type: "dragover" | "drop"): Event {
  const event = document.createEvent("Event");
  event.initEvent(type, true, true);
  if (files.length > 0) {
    Object.defineProperty(event, "dataTransfer", { value: { files } });
  }
  return event;
}

function saveButton(fixture: ViewFixture): MountRecord {
  const found = fixture
    .all("mountButton")
    .find((record) => record.props.label === "Save to Workspace");
  assert.ok(found, "the filing dialog carries its save button");
  return found!;
}

test("dropping a PDF onto the pane converts it and files it as a node-linked source item", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const root = await mounted(fixture);
    selectRoadmapCard(root, "n-skill");
    await openLedgerTab(fixture);
    const body = workspaceBody(fixture.root);
    const zone = root.querySelector<HTMLElement>(".lp-workspace-dropzone")!;
    assert.ok(zone, "the ledger tab carries its visible filing strip");

    // Drops belong to the filing strip only: a file dragged over the tab's
    // tree is not intercepted, so it never clashes with a drop aimed at the
    // path surfaces behind the floating window.
    const strayOver = dropEvent(body.ownerDocument, [], "dragover");
    body.dispatchEvent(strayOver);
    assert.equal(strayOver.defaultPrevented, false, "the tab body does not take a drop");
    assert.ok(!body.classList.contains("lp-drop-target") && !zone.classList.contains("lp-drop-target"), "nothing arms outside the filing strip");

    // The strip must allow the drop: dragover is prevented so the browser
    // delivers it, and the strip shows the armed state while hovering.
    const over = dropEvent(zone.ownerDocument, [], "dragover");
    zone.dispatchEvent(over);
    assert.equal(over.defaultPrevented, true, "the filing strip accepts a drop");
    assert.ok(zone.classList.contains("lp-drop-target"), "the armed state is visible");

    const file = new File(["%PDF-1.4 pretend bytes"], "paper.pdf", { type: "application/pdf" });
    zone.dispatchEvent(dropEvent(zone.ownerDocument, [file], "drop"));
    await fixture.flush();
    assert.ok(!zone.classList.contains("lp-drop-target"), "the armed state clears on drop");

    const dialog = fixture.all("openDialog").at(-1)!;
    assert.match(String(dialog.props.title), /paper\.pdf/, "the filing dialog opens for the dropped file");
    await fixture.flush();
    assert.equal(saveButton(fixture).props.disabled, false, "conversion enables the save");
    assert.equal(fixture.uploaded.length, 0, "no library write before the learner confirms");

    await saveButton(fixture).props.onClick();
    await fixture.flush();
    await fixture.flush();

    const call = calls(fixture, "workspace.saveSource").at(-1);
    assert.deepEqual(call?.input, {
      pathId: "path-linear-algebra",
      name: "paper.pdf",
      markdown: "# paper.pdf\n\nConverted text.",
      links: [{ to: "n-skill", rel: "grounds" }],
    }, "the picker's default (the node in view) supplies the grounds link");
    assert.equal(fixture.uploaded.length, 1, "the document lives once, in the global library");

    // The ledger re-renders with the filed source item.
    assert.ok(
      ledgerRows(fixture).some((row) => row.content === "paper.pdf"),
      "the ledger lists the filed document",
    );
    assert.ok(dialog.handle, "the dialog closed after saving");
  } finally {
    fixture.restore();
  }
});

test("a dropped file the converter cannot take surfaces the error and saves nothing", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const root = await mounted(fixture);
    selectRoadmapCard(root, "n-skill");
    await openLedgerTab(fixture);
    const zone = root.querySelector<HTMLElement>(".lp-workspace-dropzone")!;
    fixture.toMarkdown = async () => {
      throw new Error("Only UTF-8 text or a valid PDF can be converted.");
    };

    const file = new File(["%PDF-1.4 broken"], "broken.pdf", { type: "application/pdf" });
    zone.dispatchEvent(dropEvent(zone.ownerDocument, [file], "drop"));
    await fixture.flush();

    const error = root.querySelector<HTMLElement>(".lp-dialog-error");
    assert.ok(error);
    assert.match(error.textContent ?? "", /Could not convert broken\.pdf/);
    assert.match(error.textContent ?? "", /Only UTF-8 text or a valid PDF/);
    assert.equal(saveButton(fixture).props.disabled, true, "a failed conversion never enables the save");
    assert.equal(fixture.calls.filter((call) => call.name === "workspace.saveSource").length, 0);

    // Closing the dialog is the cancel path: nothing was written.
    fixture.all("openDialog").at(-1)!.handle.dispose();
    await fixture.flush();
    assert.equal(fixture.calls.filter((call) => call.name === "workspace.saveSource").length, 0);
    assert.equal(fixture.uploaded.length, 0);
  } finally {
    fixture.restore();
  }
});

test("a dropped file type outside the converter is ignored, and cancelling writes nothing", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const root = await mounted(fixture);
    selectRoadmapCard(root, "n-skill");
    await openLedgerTab(fixture);
    const zone = root.querySelector<HTMLElement>(".lp-workspace-dropzone")!;

    const image = new File(["png"], "picture.png", { type: "image/png" });
    zone.dispatchEvent(dropEvent(zone.ownerDocument, [image], "drop"));
    await fixture.flush();
    assert.equal(fixture.all("openDialog").length, 0, "an unconvertible file opens no dialog");

    const file = new File(["# Notes"], "notes.md", { type: "text/markdown" });
    zone.dispatchEvent(dropEvent(zone.ownerDocument, [file], "drop"));
    await fixture.flush();
    assert.equal(fixture.all("openDialog").length, 1, "a markdown drop opens the filing dialog");
    fixture.all("openDialog").at(-1)!.handle.dispose();
    await fixture.flush();
    assert.equal(fixture.calls.filter((call) => call.name === "workspace.saveSource").length, 0);
    assert.equal(fixture.uploaded.length, 0, "cancelling files nothing");
  } finally {
    fixture.restore();
  }
});

test("Select from computer files a picked document through the same filing dialog", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    const root = await mounted(fixture);
    selectRoadmapCard(root, "n-skill");
    await openLedgerTab(fixture);
    const zone = root.querySelector<HTMLElement>(".lp-workspace-dropzone")!;
    const input = zone.querySelector<HTMLInputElement>("input[type='file']")!;
    assert.ok(input, "the filing strip carries the native picker");

    const file = new File(["# Picked notes"], "picked.md", { type: "text/markdown" });
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    fire(input, "change");
    await fixture.flush();

    const dialog = fixture.all("openDialog").at(-1)!;
    assert.match(String(dialog.props.title), /picked\.md/, "the picked file opens the filing dialog");
    await fixture.flush();
    await saveButton(fixture).props.onClick();
    await fixture.flush();
    await fixture.flush();

    const call = calls(fixture, "workspace.saveSource").at(-1);
    assert.deepEqual(call?.input, {
      pathId: "path-linear-algebra",
      name: "picked.md",
      markdown: "# picked.md\n\nConverted text.",
      links: [{ to: "n-skill", rel: "grounds" }],
    }, "one learner write files the picked document like a dropped one");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("the ledger is the floating window's second tab: same window, same Expand, long note reads whole", async () => {
  const path = makePath();
  const longBody = `# Long note\n\n${"paragraph of the learner's own writing.\n\n".repeat(40)}`;
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [{ item: initialItem(), content: longBody }],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    const pane = inspectorPane(fixture.root);
    await openLedgerTab(fixture);
    assert.ok(
      fixture.all("mountButton").every((record) => !/fullscreen/i.test(String(record.props.label ?? ""))),
      "no fullscreen affordance anywhere: the window's Expand is the one big-surface toggle",
    );

    // The long note reads whole: the preview expands in place inside the
    // window's own scroller — no bounded viewer window caps it.
    await expandRow(fixture, 0);
    const markdown = fixture.all("mountMarkdown").at(-1);
    assert.ok(markdown, "the preview renders inside the window");
    assert.equal(markdown!.props.text, longBody, "the full text is one read, one render");

    // The window's Expand stretches the ledger exactly as it does the
    // details, and the ledger keeps its place across the toggle.
    const expand = fixture
      .all("mountButton")
      .filter((record) => record.props.label === "Expand" && pane.contains(record.container))[0]!;
    await expand.props.onClick();
    await fixture.flush();
    assert.ok(pane.classList.contains("lp-inspector-expanded"), "Expand stretches the window with the ledger in it");
    assert.equal(ledgerRows(fixture)[0]!.disclosure!.expanded, true, "the preview survives the toggle");
    const restore = fixture
      .all("mountButton")
      .filter((record) => record.props.label === "Restore" && pane.contains(record.container))[0]!;
    await restore.props.onClick();
    await fixture.flush();
    assert.ok(!pane.classList.contains("lp-inspector-expanded"));

    // Collapsing the preview never re-reads; switching tabs keeps the ledger
    // mounted, hidden, one click away.
    await ledgerRows(fixture)[0]!.disclosure!.onChange(false);
    await fixture.flush();
    inspectorTab(fixture.root, /^Node details/).click();
    await fixture.flush();
    assert.equal(workspaceBody(fixture.root).hidden, true, "the details tab hides the ledger");
    await openLedgerTab(fixture);
    assert.equal(calls(fixture, "workspace.readItem").length, 1, "no refetch across tab switches");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("Open folder reveals the selected path's workspace through the learner's file manager", async () => {
  const path = makePath();
  const fixture = createViewFixture({ paths: [path] });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await openLedgerTab(fixture);

    const openFolder = nativeButtonIn(workspaceBody(fixture.root), "Open folder");
    openFolder.click();
    await fixture.flush();

    const opened = fixture.calls.filter((call) => call.name === "workspace.openDirectory");
    assert.deepEqual(opened.at(-1)?.input, { pathId: "path-linear-algebra" }, "the affordance goes through the backend RPC");
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("Open in editor hands a content item's file to the OS; a source owns no file and no affordance", async () => {
  const path = makePath();
  const source = makeItem({
    id: ITEM_ID_2,
    kind: "source",
    title: "Canonical linear algebra notes",
    sourceId: "source-1",
  });
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [
      { item: initialItem(), content: "the learner's own writing" },
      { item: source, content: null },
    ],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await openLedgerTab(fixture);

    const body = workspaceBody(fixture.root);
    const open = nativeButtonIn(body, "Open in editor…");
    open.click();
    await fixture.flush();

    const opened = calls(fixture, "workspace.openItem");
    assert.deepEqual(
      opened.at(-1)?.input,
      { pathId: "path-linear-algebra", itemId: ITEM_ID },
      "the item's file leaves through one backend RPC, which prompts the OS for the application",
    );

    // A source references the global library; its row never offers the button.
    const sourceRow = ledgerRows(fixture)[1]!;
    const actions = sourceRow.cells?.actions as HTMLElement;
    assert.ok(actions && typeof actions !== "string");
    assert.equal(
      [...actions.querySelectorAll("button")].some((button) => button.getAttribute("aria-label") === "Open in editor…"),
      false,
      "a source carries no content file, so there is nothing to hand to an editor",
    );
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});

test("row actions read as icons: an outbound arrow, a chain link, a trashcan", async () => {
  const path = makePath();
  const fixture = createViewFixture({
    paths: [path],
    workspaceItems: [{ item: initialItem(), content: "body" }],
  });
  try {
    await mounted(fixture);
    selectRoadmapCard(fixture.root, "n-skill");
    await openLedgerTab(fixture);

    const body = workspaceBody(fixture.root);
    // Icon-only: the label stays the accessible name, the hover title carries
    // the word, and the glyph is the look.
    for (const label of ["Open in editor…", "Links…", "Delete"]) {
      const found = nativeButtonIn(body, label);
      assert.equal(found.textContent, "", `${label} reads as a glyph, not words`);
      assert.ok(found.querySelector("svg"), `${label} is drawn as SVG line art`);
    }
    assert.equal(
      nativeButtonIn(body, "Links…").title,
      "Link to a node",
      "the chain link's hover title says what filing does",
    );
  } finally {
    clearPathHubTarget();
    fixture.restore();
  }
});
