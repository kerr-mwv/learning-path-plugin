/** Shared child-session shapes across the launcher, dialogs and Path Hub.
 *
 * Types only: every value here crosses the JSON `ctx.call` bridge from the
 * backend, which validates it and owns the authoritative path record.
 */
import type { ChildSessionKind, ChildSessionLink, LearningPath } from "./domain.ts";

export interface LinkedParent {
  readonly chatId: string;
  readonly pathId: string;
  readonly pathTitle: string;
  readonly nodeId: string;
  readonly nodeTitle: string;
  readonly kind: ChildSessionKind;
  readonly label: string;
  readonly createdAt: string;
}

export interface SessionStatus {
  readonly chatId: string;
  readonly kind: ChildSessionKind;
  readonly label: string;
  /** False when the native chat was deleted or otherwise cannot be read. */
  readonly exists: boolean;
  readonly title: string | null;
  readonly updatedAt: string | null;
}

export interface AvailableSession {
  readonly chatId: string;
  readonly title: string;
  readonly kind: ChildSessionKind;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly busy: boolean;
  readonly linked: {
    readonly pathId: string;
    readonly pathTitle: string;
    readonly nodeId: string;
    readonly nodeTitle: string;
    readonly kind: ChildSessionKind;
  } | null;
}

export interface PreparedLaunch {
  readonly pathId: string;
  readonly pathTitle: string;
  readonly nodeId: string;
  readonly nodeTitle: string;
  readonly kind: ChildSessionKind;
  readonly title: string;
  readonly prompt: string;
  readonly watchpoints: number;
}

export interface SessionLinkResult {
  readonly path: LearningPath;
  readonly link: ChildSessionLink;
  readonly deduplicated?: boolean;
}

export interface SessionParentResult {
  readonly link: LinkedParent | null;
  readonly exists: boolean;
}
