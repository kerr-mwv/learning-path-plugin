/** Shared, valid domain fixtures for domain, framework and store tests. */
import type { LearningPath, PathNode, SourceAnchor } from "../src/domain.ts";

export const AT = "2026-01-31T09:30:00.000Z";

export function anchor(reference = "OSTEP"): SourceAnchor {
  return { reference, chapter: "26", section: "27.1", pages: "301-320" };
}

export function makeNode(
  id: string,
  type: PathNode["type"],
  overrides: Partial<PathNode> = {},
): PathNode {
  return {
    id,
    type,
    title: `Node ${id}`,
    goal: `Understand ${id} from first principles.`,
    sourceAnchor: anchor(),
    interleavesNodeIds: [],
    progression: "unstarted",
    childSessions: [],
    errors: [],
    pivotSuggestions: [],
    ...overrides,
  };
}

/** One path exercising all six node types and all three progression states. */
export function makePath(): LearningPath {
  return {
    id: "path-linear-algebra",
    title: "Linear algebra from canon",
    goal: "Build durable linear-algebra understanding.",
    createdAt: AT,
    updatedAt: AT,
    sourceSpine: {
      mode: "canonical",
      references: [{ title: "OSTEP", author: "Arpaci-Dusseau", edition: "1.0", kind: "textbook" }],
    },
    modules: [
      {
        id: "module-structure",
        title: "Structure first",
        nodes: [
          makeNode("n-holistic", "holistic", {
            lightPreReading: "Skim the module overview and the running example.",
            progression: "consolidated",
            errors: [
              {
                id: "err-holistic",
                category: "misconception",
                summary: "Assumes the map is the proof.",
                resolved: true,
                createdAt: AT,
                resolvedAt: AT,
              },
            ],
          }),
          makeNode("n-concept", "concept", {
            lightPreReading: "Skim the module overview and the running example.",
            interleavesNodeIds: ["n-holistic"],
            progression: "in_progress",
            artifactConfig: { type: "micro_code", instructions: "Write the smallest failing interpreter." },
            childSessions: [
              { chatId: "chat-1", kind: "teaching", createdAt: AT, label: "First teaching chat" },
            ],
          }),
          makeNode("n-skill", "skill", {
            interleavesNodeIds: ["n-concept"],
            errors: [
              {
                id: "err-skill",
                category: "procedural_slip",
                summary: "Drops a sign while expanding.",
                resolved: false,
                createdAt: AT,
                sessionChatId: "chat-1",
              },
            ],
            pivotSuggestions: [
              {
                id: "pivot-skill",
                status: "pending",
                proposalType: "skill",
                title: "Add a sign-tracking drill",
                rationale: "Mechanics keep slipping while the idea is understood.",
                createdAt: AT,
              },
            ],
          }),
        ],
      },
      {
        id: "module-synthesis",
        title: "Synthesis",
        nodes: [
          makeNode("n-contrast", "contrast", {
            interleavesNodeIds: ["n-concept", "n-skill"],
            progression: "unstarted",
          }),
          makeNode("n-checkpoint", "checkpoint", {
            interleavesNodeIds: ["n-holistic", "n-contrast"],
          }),
          makeNode("n-bridge", "bridge", {
            interleavesNodeIds: ["n-skill"],
            progression: "in_progress",
            pivotSuggestions: [
              {
                id: "pivot-bridge",
                status: "dismissed",
                proposalType: "bridge",
                title: "Repair matrix multiplication",
                rationale: "Prerequisite gap surfaced in practice.",
                createdAt: AT,
                resolvedAt: AT,
              },
            ],
          }),
        ],
      },
    ],
    artifactDefault: "retrieval_cue",
    architectChatId: "chat-architect",
  };
}

export const clone = <T>(value: T): T => structuredClone(value);
export const rawPath = (): any => clone(makePath());
