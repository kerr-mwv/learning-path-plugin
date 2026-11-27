/** Learning Path Companion Demo — frontend.
 *
 * A deliberately plain read-only view: it calls the demo backend's three
 * operations and renders exactly what the integration surface returned, so
 * a developer can eyeball whether a companion really sees paths, nodes,
 * notes and watchpoints. No styling files, no chrome of its own. */
import type { PluginFrontendContext } from "learnharness-plugin-api";

type Overview = {
  ok: boolean;
  error?: string;
  apiVersion?: number;
  dataDirectory?: string;
  capabilities?: readonly string[];
  paths?: readonly {
    id: string;
    title: string;
    goal: string;
    nodeCount: number;
    unresolvedErrorCount: number;
    openErrors: number;
    pendingPivots: number;
    folder: string | null;
  }[];
};

type Structure = {
  ok: boolean;
  error?: string;
  modules?: readonly {
    id: string;
    title: string;
    nodes: readonly {
      id: string;
      type: string;
      title: string;
      progression: string;
      items: readonly { id: string; title: string; kind: string }[];
    }[];
  }[];
};

type NodeNotes = {
  ok: boolean;
  error?: string;
  node?: { title: string; type: string; goal: string; artifactType: string };
  errors?: readonly { summary: string; category: string }[];
  notes?: readonly { title: string; kind: string; preview: string | null }[];
};

function text(kind: "h2" | "h3" | "p" | "li" | "strong", value: string): HTMLElement {
  const element = document.createElement(kind);
  element.textContent = value;
  return element;
}

export function activate(ctx: PluginFrontendContext): () => void {
  const disposers: (() => void)[] = [];

  disposers.push(
    ctx.registerView({
      id: "companion-demo",
      name: "LP Companion Demo",
      mount(container, signal) {
        container.classList.add("companion-demo-view");
        const render = (element: HTMLElement): void => {
          if (!signal.aborted) container.replaceChildren(element);
        };
        const report = document.createElement("section");

        ctx
          .call<Overview>("demo.overview")
          .then((overview) => {
            if (signal.aborted) return;
            if (!overview.ok) {
              report.replaceChildren(
                text("h2", "Learning Path integration: not available"),
                text("p", overview.error ?? "Unknown failure."),
              );
              render(report);
              return;
            }
            report.append(
              text("h2", "Learning Path integration v" + String(overview.apiVersion)),
              text("p", `Store: ${overview.dataDirectory}`),
              text("p", `Capabilities: ${overview.capabilities?.join(", ")}`),
            );
            for (const summary of overview.paths ?? []) {
              const button = document.createElement("button");
              button.textContent = `${summary.title} — ${summary.nodeCount} nodes, ${summary.openErrors} open errors`;
              button.addEventListener("click", () => {
                if (signal.aborted) return;
                ctx
                  .call<Structure>("demo.structure", { pathId: summary.id })
                  .then((structure) => renderStructure(structure, summary.id));
              });
              report.append(button);
            }
            render(report);
          })
          .catch((error: unknown) => {
            report.replaceChildren(
              text("h2", "Learning Path integration: backend call failed"),
              text("p", String((error as Error)?.message ?? error)),
            );
            render(report);
          });

        const renderStructure = (structure: Structure, pathId: string): void => {
          if (signal.aborted) return;
          const element = document.createElement("section");
          if (!structure.ok) {
            element.append(text("p", structure.error ?? "Unknown failure."));
            render(element);
            return;
          }
          for (const module of structure.modules ?? []) {
            element.append(text("h3", `Module: ${module.title}`));
            for (const node of module.nodes) {
              const row = document.createElement("p");
              row.append(
                text("strong", `${node.type} · ${node.title} (${node.progression})`),
              );
              if (node.items.length > 0) {
                const button = document.createElement("button");
                button.textContent = `Notes (${node.items.length})`;
                button.addEventListener("click", () => {
                  ctx
                    .call<NodeNotes>("demo.nodeNotes", { pathId, nodeId: node.id })
                    .then((notes) => renderNotes(notes));
                });
                row.append(button);
              }
              element.append(row);
            }
          }
          render(element);
        };

        const renderNotes = (notes: NodeNotes): void => {
          if (signal.aborted) return;
          const element = document.createElement("section");
          if (!notes.ok) {
            element.append(text("p", notes.error ?? "Unknown failure."));
            render(element);
            return;
          }
          element.append(
            text("h2", notes.node?.title ?? "Node"),
            text("p", `Artifact: ${notes.node?.artifactType}`),
            text("p", `Open errors: ${notes.errors?.length ?? 0}`),
          );
          for (const error of notes.errors ?? []) {
            element.append(text("li", `${error.category}: ${error.summary}`));
          }
          for (const note of notes.notes ?? []) {
            element.append(text("h3", `${note.kind}: ${note.title}`));
            element.append(text("p", note.preview ?? "(no content)"));
          }
          render(element);
        };

        return () => {
          container.replaceChildren();
          container.classList.remove("companion-demo-view");
        };
      },
    }),
  );

  disposers.push(
    ctx.registerAction({
      id: "open-companion-demo",
      name: "Open LP Companion Demo",
      run: () => ctx.app.openView("companion-demo"),
    }),
  );
  disposers.push(
    ctx.placeAction({ id: "companion-demo-sidebar", actionId: "open-companion-demo", location: "sidebar" }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
