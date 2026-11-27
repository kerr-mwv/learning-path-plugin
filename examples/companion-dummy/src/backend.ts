/** Learning Path Companion Demo — backend.
 *
 * The whole point of this plugin: prove that a third-party companion can
 * serve real Learning Path data through the v1 integration contract,
 * strictly read-only, without any host support for cross-plugin calls.
 *
 * It discovers the Learning Path data directory from its own plugin
 * directory (community plugins are siblings), opens the integration reader
 * and exposes three `ctx.handle` operations for its frontend. Nothing here
 * ever writes to the Learning Path store; anything this plugin would store
 * belongs in its own `ctx.dataDirectory`.
 */
import path from "node:path";
import type { PluginBackendContext } from "learnharness-plugin-api";
import {
  createFileStoreIntegration,
  discoverLearningPathDataDirectory,
} from "../../../src/integration/reader.ts";
import type { LearningPathIntegration } from "../../../src/integration/api.ts";

export function activate(ctx: PluginBackendContext): (() => void) | void {
  const dataDirectory =
    process.env.LP_COMPANION_DATA_DIR?.trim() || discoverLearningPathDataDirectory(ctx.directory);
  const integration: LearningPathIntegration = createFileStoreIntegration({ dataDirectory });
  const disposers: (() => void)[] = [];

  const live = (): void => {
    if (ctx.signal.aborted) throw new Error("The companion demo backend is shutting down.");
  };

  /** Everything a companion can see at a glance. */
  disposers.push(
    ctx.handle("demo.overview", () => {
      live();
      const capabilities = integration.getCapabilities();
      if (!capabilities.includes("paths")) {
        return { ok: false, error: `No Learning Path store found at ${dataDirectory}. Create a path first.` };
      }
      return {
        ok: true,
        apiVersion: integration.apiVersion,
        dataDirectory,
        capabilities,
        paths: integration.listPaths().map((summary) => ({
          ...summary,
          openErrors: integration.listOpenErrors(summary.id)?.length ?? 0,
          pendingPivots: integration.listPendingPivots(summary.id)?.length ?? 0,
        })),
      };
    }),
  );

  /** Units and their inventory: modules, nodes, workspace items per node. */
  disposers.push(
    ctx.handle("demo.structure", (input) => {
      live();
      const pathId = (input as { pathId?: unknown })?.pathId;
      if (typeof pathId !== "string") throw new Error("demo.structure expects { pathId }.");
      const modules = integration.listModules(pathId);
      if (!modules) return { ok: false, error: `Unknown path: ${pathId}` };
      return {
        ok: true,
        modules: modules.map((module) => ({
          ...module,
          nodes: (integration.listNodes(pathId, module.id) ?? []).map((node) => ({
            ...node,
            items: integration.listWorkspaceItems(pathId, { nodeId: node.id }) ?? [],
          })),
        })),
      };
    }),
  );

  /** One node's full context plus a bounded read of each linked note — the
   * canonical "units and their notes" flow. */
  disposers.push(
    ctx.handle("demo.nodeNotes", (input) => {
      live();
      const value = input as { pathId?: unknown; nodeId?: unknown };
      if (typeof value?.pathId !== "string" || typeof value?.nodeId !== "string") {
        throw new Error("demo.nodeNotes expects { pathId, nodeId }.");
      }
      const { pathId, nodeId } = value;
      const node = integration.getNode(pathId, nodeId);
      if (!node) return { ok: false, error: `Unknown node: ${nodeId}` };
      const items = integration.listWorkspaceItems(pathId, { nodeId }) ?? [];
      const notes = items.map((item) => {
        const chunk = integration.readWorkspaceItem(pathId, item.id, { maxBytes: 1024 });
        return { title: item.title, kind: item.kind, preview: chunk?.text ?? null };
      });
      return {
        ok: true,
        node,
        errors: integration.listOpenErrors(pathId, nodeId) ?? [],
        notes,
      };
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
