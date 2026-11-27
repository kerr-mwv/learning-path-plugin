/** Learning Path companion integration — default file-store implementation.
 *
 * Serves `LearningPathIntegration` (v1) from the Learning Path plugin's
 * versioned store, without ever opening it through `openLearningPathStore`:
 * that entry point owns migrations and writes, and a companion must be
 * strictly read-only. Instead this module reads exactly the documents the
 * store layout defines and reuses the domain validators from `../domain.ts`
 * so a companion sees the same strictness as the plugin itself.
 *
 * Safety mirrors the store: ids are pattern-checked before path joins,
 * symlinks are refused, writes never happen, and a newer store schema is an
 * `unsupportedVersion` error rather than a guess. Reads are snapshots of
 * atomically renamed files, so a concurrent plugin write is never observed
 * half-done.
 */
import fs from "node:fs";
import path from "node:path";
import {
  DomainValidationError,
  defaultArtifactFor,
  parseWorkspaceManifest,
  validateLearningPath,
} from "../domain.ts";
import type { LearningPath, PathNode, WorkspaceItem, WorkspaceManifest } from "../domain.ts";
import {
  IntegrationError,
  INTEGRATION_API_VERSION,
  SUPPORTED_STORE_SCHEMA_VERSION,
  type FileStoreIntegrationOptions,
  type IntegrationProgression,
  type LearningPathCapability,
  type LearningPathIntegration,
  type LearningPathSummary,
  type ModuleSummary,
  type NodeDetail,
  type NodeSummary,
  type OpenErrorRef,
  type PendingPivotRef,
  type WorkspaceItemChunk,
  type WorkspaceItemRef,
} from "./api.ts";

/** Community plugins are siblings: `community plugins/<id>/dist` and
 * `community plugins/<id>/data`. From any plugin's code directory, the
 * Learning Path data directory is two levels up plus `learning-path/data`. */
export function discoverLearningPathDataDirectory(
  fromPluginDirectory: string,
  pluginId = "learning-path",
): string {
  return path.resolve(fromPluginDirectory, "..", "..", pluginId, "data");
}

const PATH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ITEM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PATHS_DIRECTORY = "paths";
const WORKSPACES_DIRECTORY = "workspaces";
const WORKSPACE_MANIFEST_FILE = "manifest.json";
const WORKSPACE_FILES_DIRECTORY = "files";

/** Bounded reads: 32 KiB per call by default, capped at one item's full size
 * (the store bounds content-bearing items at 256 KiB). */
const DEFAULT_CHUNK_BYTES = 32 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;

const CAPABILITIES: readonly LearningPathCapability[] = ["paths", "structure", "workspace", "errors", "pivots"];

/** Refuse traversal and non-ids before any path join. */
function assertIdShape(id: string, kind: "path" | "item"): void {
  const valid = kind === "path" ? PATH_ID_PATTERN.test(id) : ITEM_ID_PATTERN.test(id);
  if (!valid || id.includes("..")) {
    throw new IntegrationError("corruptRecord", `Invalid Learning Path ${kind} id: ${JSON.stringify(id)}.`);
  }
}

/** Resolve strictly inside `base` after the id shape is checked. */
function joinInside(base: string, id: string, kind: "path" | "item"): string {
  assertIdShape(id, kind);
  const resolvedBase = path.resolve(base);
  const filename = path.resolve(resolvedBase, id);
  if (!filename.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new IntegrationError("corruptRecord", `Refusing to resolve outside ${resolvedBase}: ${filename}.`);
  }
  return filename;
}

/** Read one JSON file, refusing symlinks as the store does. */
function readJsonFile(filename: string): unknown | undefined {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (stat.isSymbolicLink()) {
    throw new IntegrationError("corruptRecord", `Refusing to follow symlinked store file: ${filename}.`);
  }
  if (!stat.isFile()) {
    throw new IntegrationError("corruptRecord", `Store location is not a regular file: ${filename}.`);
  }
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    throw new IntegrationError("corruptRecord", `Corrupt JSON at ${filename}: ${(error as Error).message}`);
  }
}

/** Every store document carries `schemaVersion`; only the declared one is
 * supported. Anything else — older or newer — fails loud, never guesses. */
function readSchemaVersion(record: Record<string, unknown>, filename: string): number {
  const version = record.schemaVersion;
  if (version !== SUPPORTED_STORE_SCHEMA_VERSION) {
    throw new IntegrationError(
      "unsupportedVersion",
      `Learning Path data at ${filename} uses schema version ${String(version)}; this integration supports ${SUPPORTED_STORE_SCHEMA_VERSION}.`,
    );
  }
  return version as number;
}

function asRecord(value: unknown, filename: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IntegrationError("corruptRecord", `Corrupt store document at ${filename}: expected a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/** Load and validate one path record; null when the file does not exist. */
function loadPathRecord(pathsDirectory: string, pathId: string): LearningPath | null {
  const filename = joinInside(pathsDirectory, pathId, "path") + ".json";
  const raw = readJsonFile(filename);
  if (raw === undefined) return null;
  const record = asRecord(raw, filename);
  readSchemaVersion(record, filename);
  const result = validateLearningPath(record.path);
  if (!result.ok) {
    const issue = result.issues[0];
    throw new IntegrationError(
      "corruptRecord",
      `Corrupt path record at ${filename}: ${issue?.path ?? ""} ${issue?.message ?? "is invalid"}.`,
    );
  }
  return result.value;
}

function summarize(record: LearningPath): LearningPathSummary {
  const nodes = record.modules.flatMap((module) => module.nodes);
  const counters: Record<IntegrationProgression, number> = {
    unstarted: 0,
    in_progress: 0,
    consolidated: 0,
  };
  let pendingPivotCount = 0;
  let unresolvedErrorCount = 0;
  for (const node of nodes) {
    counters[node.progression] += 1;
    pendingPivotCount += node.pivotSuggestions.filter((pivot) => pivot.status === "pending").length;
    unresolvedErrorCount += node.errors.filter((error) => !error.resolved).length;
  }
  const spine = record.sourceSpine;
  const sourceTitles =
    spine.mode === "canonical"
      ? spine.references.map((reference) => reference.title)
      : spine.sources.map((source) => source.name);
  return {
    id: record.id,
    title: record.title,
    goal: record.goal,
    updatedAt: record.updatedAt,
    sourceMode: spine.mode,
    sourceTitles,
    moduleCount: record.modules.length,
    nodeCount: nodes.length,
    nodeStates: counters,
    pendingPivotCount,
    unresolvedErrorCount,
    tags: record.tags ?? [],
    folder: record.folder ?? null,
  };
}

function moduleOf(record: LearningPath, moduleId: string) {
  return record.modules.find((module) => module.id === moduleId) ?? null;
}

function nodeSummary(moduleId: string, node: PathNode): NodeSummary {
  return {
    id: node.id,
    moduleId,
    type: node.type,
    title: node.title,
    goal: node.goal,
    progression: node.progression,
    sourceAnchor: node.sourceAnchor,
    unresolvedErrorCount: node.errors.filter((error) => !error.resolved).length,
    pendingPivotCount: node.pivotSuggestions.filter((pivot) => pivot.status === "pending").length,
    childSessionCount: node.childSessions.length,
  };
}

function nodeDetail(moduleId: string, record: LearningPath, node: PathNode): NodeDetail {
  return {
    ...nodeSummary(moduleId, node),
    ...(node.lightPreReading === undefined ? {} : { lightPreReading: node.lightPreReading }),
    interleavesNodeIds: node.interleavesNodeIds,
    artifactType: node.artifactConfig?.type ?? record.artifactDefault ?? defaultArtifactFor(node.type),
    ...(node.artifactNote === undefined ? {} : { artifactNote: node.artifactNote }),
    childSessions: node.childSessions.map((session) => ({ ...session })),
  };
}

function itemRef(item: WorkspaceItem): WorkspaceItemRef {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    addedAt: item.addedAt,
    addedBy: item.addedBy,
    ...(item.caption === undefined ? {} : { caption: item.caption }),
    links: item.links.map((link) => ({ ...link })),
    ...(item.byteSize === undefined ? {} : { byteSize: item.byteSize }),
    ...(item.sourceId === undefined ? {} : { sourceId: item.sourceId }),
  };
}

/** The path's workspace manifest, or null before the first item materializes
 * it. Links to nodes the path no longer has are dropped at read, exactly as
 * the plugin's own store does. */
function loadWorkspace(
  workspacesDirectory: string,
  record: LearningPath,
): WorkspaceManifest | null {
  const filename = path.join(
    joinInside(workspacesDirectory, record.id, "path"),
    WORKSPACE_MANIFEST_FILE,
  );
  const raw = readJsonFile(filename);
  if (raw === undefined) return null;
  const envelope = asRecord(raw, filename);
  readSchemaVersion(envelope, filename);
  let manifest: WorkspaceManifest;
  try {
    manifest = parseWorkspaceManifest(envelope);
  } catch (error) {
    if (!(error instanceof DomainValidationError)) throw error;
    const issue = error.issues[0];
    throw new IntegrationError(
      "corruptRecord",
      `Corrupt workspace manifest at ${filename}: ${issue?.path ?? ""} ${issue?.message ?? "is invalid"}.`,
    );
  }
  if (manifest.pathId !== record.id) {
    throw new IntegrationError(
      "corruptRecord",
      `Corrupt workspace manifest at ${filename}: pathId "${manifest.pathId}" does not match "${record.id}".`,
    );
  }
  const nodeIds = new Set(record.modules.flatMap((module) => module.nodes.map((node) => node.id)));
  return {
    ...manifest,
    items: manifest.items.map((item) => ({
      ...item,
      links: item.links.filter((link) => link.to === "space" || nodeIds.has(link.to)),
    })),
  };
}

/** Find an item's content file: `<slug>-<itemId>.md` today, bare
 * `<itemId>.md` historically, or by frontmatter id after an external rename.
 * Mirrors the store's lookup, including its refusal to follow symlinks. */
function findWorkspaceContentFile(filesDirectory: string, itemId: string): string | null {
  const dirStat = fs.lstatSync(filesDirectory, { throwIfNoEntry: false });
  if (!dirStat || !dirStat.isDirectory()) return null;
  const entries = fs.readdirSync(filesDirectory, { withFileTypes: true });
  for (const entry of entries) {
    if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".md")) continue;
    const basename = entry.name.slice(0, -3);
    if (basename === itemId || basename.endsWith(`-${itemId}`)) {
      return path.join(filesDirectory, entry.name);
    }
  }
  // Renamed externally: match by frontmatter id. Regular files only.
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const fullPath = path.join(filesDirectory, entry.name);
    let raw: string;
    try {
      raw = fs.readFileSync(fullPath, "utf8");
    } catch {
      continue; // a save race with an external editor
    }
    for (const line of raw.split("\n").slice(0, 4)) {
      const match = /^id:\s*"?([a-f0-9-]{36})"?/.exec(line);
      if (match && match[1] === itemId) return fullPath;
    }
  }
  return null;
}

/** Strip YAML frontmatter exactly as the store writes and reads it. The
 * delimiter search starts after the opening fence so a note whose body begins
 * with `---` is never cut short. Content after the fence is verbatim. */
function stripWorkspaceFrontmatter(raw: string): string {
  if (!raw.startsWith("---\n")) return raw;
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return raw;
  return raw.slice(end + 5);
}

/** UTF-8 byte slice that never splits a multibyte character: if the cut
 * lands inside a character (the byte at `end` is a continuation), advance to
 * the character's end instead — at most 3 bytes over `maxBytes`, and progress
 * is always guaranteed. */
function decodeUtf8Range(buffer: Buffer, offset: number, maxBytes: number): { text: string; end: number } {
  const end = Math.min(offset + maxBytes, buffer.length);
  let safeEnd = end;
  if (end < buffer.length && (buffer[end]! & 0xc0) === 0x80) {
    while (safeEnd < buffer.length && (buffer[safeEnd]! & 0xc0) === 0x80) safeEnd += 1;
  }
  return { text: buffer.subarray(offset, safeEnd).toString("utf8"), end: safeEnd };
}

/** Serve the v1 integration from a Learning Path data directory. */
export function createFileStoreIntegration(
  options: FileStoreIntegrationOptions,
): LearningPathIntegration {
  const dataDirectory = path.resolve(options.dataDirectory);
  const pathsDirectory = path.join(dataDirectory, PATHS_DIRECTORY);
  const workspacesDirectory = path.join(dataDirectory, WORKSPACES_DIRECTORY);

  const requireStore = (): void => {
    const stat = fs.lstatSync(dataDirectory, { throwIfNoEntry: false });
    if (!stat) {
      throw new IntegrationError("storeNotFound", `No Learning Path store at ${dataDirectory}.`);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new IntegrationError("storeNotFound", `Learning Path store location is not a directory: ${dataDirectory}.`);
    }
  };

  const loadPath = (pathId: string): LearningPath | null => {
    requireStore();
    return loadPathRecord(pathsDirectory, pathId);
  };

  return {
    apiVersion: INTEGRATION_API_VERSION,

    getCapabilities(): readonly LearningPathCapability[] {
      const stat = fs.lstatSync(dataDirectory, { throwIfNoEntry: false });
      return stat && stat.isDirectory() && !stat.isSymbolicLink() ? CAPABILITIES : [];
    },

    listPaths(): readonly LearningPathSummary[] {
      requireStore();
      const stat = fs.lstatSync(pathsDirectory, { throwIfNoEntry: false });
      if (!stat || !stat.isDirectory()) return [];
      const summaries: LearningPathSummary[] = [];
      for (const entry of fs.readdirSync(pathsDirectory, { withFileTypes: true }).sort(
        (a, b) => (a.name < b.name ? -1 : 1),
      )) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const pathId = entry.name.slice(0, -".json".length);
        const record = loadPathRecord(pathsDirectory, pathId);
        if (record) summaries.push(summarize(record));
      }
      return summaries;
    },

    getPath(pathId: string): LearningPathSummary | null {
      const record = loadPath(pathId);
      return record ? summarize(record) : null;
    },

    listModules(pathId: string): readonly ModuleSummary[] | null {
      const record = loadPath(pathId);
      if (!record) return null;
      return record.modules.map((module) => ({
        id: module.id,
        title: module.title,
        ...(module.goal === undefined ? {} : { goal: module.goal }),
        nodeCount: module.nodes.length,
      }));
    },

    listNodes(pathId: string, moduleId?: string): readonly NodeSummary[] | null {
      const record = loadPath(pathId);
      if (!record) return null;
      if (moduleId !== undefined) {
        const module = moduleOf(record, moduleId);
        if (!module) return null;
        return module.nodes.map((node) => nodeSummary(moduleId, node));
      }
      return record.modules.flatMap((module) =>
        module.nodes.map((node) => nodeSummary(module.id, node)),
      );
    },

    getNode(pathId: string, nodeId: string): NodeDetail | null {
      const record = loadPath(pathId);
      if (!record) return null;
      for (const module of record.modules) {
        const node = module.nodes.find((candidate) => candidate.id === nodeId);
        if (node) return nodeDetail(module.id, record, node);
      }
      return null;
    },

    listWorkspaceItems(
      pathId: string,
      filter?: { readonly nodeId?: string; readonly kind?: WorkspaceItemRef["kind"] },
    ): readonly WorkspaceItemRef[] | null {
      const record = loadPath(pathId);
      if (!record) return null;
      const manifest = loadWorkspace(workspacesDirectory, record);
      if (!manifest) return [];
      return manifest.items
        .filter((item) => filter?.kind === undefined || item.kind === filter.kind)
        .filter(
          (item) =>
            filter?.nodeId === undefined || item.links.some((link) => link.to === filter.nodeId),
        )
        .map(itemRef);
    },

    readWorkspaceItem(
      pathId: string,
      itemId: string,
      range?: { readonly offset?: number; readonly maxBytes?: number },
    ): WorkspaceItemChunk | null {
      // Loud on malformed ids: an integration should never quietly map a bad
      // identifier onto a null result.
      assertIdShape(itemId, "item");
      const record = loadPath(pathId);
      if (!record) return null;
      const manifest = loadWorkspace(workspacesDirectory, record);
      const item = manifest?.items.find((candidate) => candidate.id === itemId);
      if (!item) return null;
      // Source items reference the global sources store; their content is not
      // workspace content and is never served here.
      if (item.kind === "source") return null;
      const filename = findWorkspaceContentFile(
        path.join(joinInside(workspacesDirectory, pathId, "path"), WORKSPACE_FILES_DIRECTORY),
        itemId,
      );
      if (!filename) return null;
      const stat = fs.lstatSync(filename);
      if (stat.isSymbolicLink() || !stat.isFile()) return null;

      const offset = range?.offset === undefined ? 0 : range.offset;
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new IntegrationError("corruptRecord", `Invalid read offset: ${String(range?.offset)}.`);
      }
      const requested = range?.maxBytes === undefined ? DEFAULT_CHUNK_BYTES : range.maxBytes;
      if (!Number.isSafeInteger(requested) || requested <= 0) {
        throw new IntegrationError("corruptRecord", `Invalid read size: ${String(range?.maxBytes)}.`);
      }
      const maxBytes = Math.min(requested, MAX_CHUNK_BYTES);

      const raw = fs.readFileSync(filename, "utf8");
      const content = stripWorkspaceFrontmatter(raw);
      const buffer = Buffer.from(content, "utf8");
      if (offset >= buffer.length) return { text: "", nextOffset: null };
      const { text, end } = decodeUtf8Range(buffer, offset, maxBytes);
      return { text, nextOffset: end < buffer.length ? end : null };
    },

    listOpenErrors(pathId: string, nodeId?: string): readonly OpenErrorRef[] | null {
      const record = loadPath(pathId);
      if (!record) return null;
      const errors: OpenErrorRef[] = [];
      for (const module of record.modules) {
        for (const node of module.nodes) {
          if (nodeId !== undefined && node.id !== nodeId) continue;
          for (const error of node.errors) {
            if (error.resolved) continue;
            errors.push({
              id: error.id,
              nodeId: node.id,
              category: error.category,
              summary: error.summary,
              ...(error.notes === undefined ? {} : { notes: error.notes }),
              createdAt: error.createdAt,
              ...(error.sessionChatId === undefined ? {} : { sessionChatId: error.sessionChatId }),
            });
          }
        }
      }
      return errors;
    },

    listPendingPivots(pathId: string): readonly PendingPivotRef[] | null {
      const record = loadPath(pathId);
      if (!record) return null;
      const pivots: PendingPivotRef[] = [];
      for (const module of record.modules) {
        for (const node of module.nodes) {
          for (const pivot of node.pivotSuggestions) {
            if (pivot.status !== "pending") continue;
            pivots.push({
              id: pivot.id,
              nodeId: node.id,
              proposalType: pivot.proposalType,
              title: pivot.title,
              rationale: pivot.rationale,
            });
          }
        }
      }
      return pivots;
    },
  };
}
