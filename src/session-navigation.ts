/** Learning Path — one-window "open this node in the Path Hub" hand-off.
 *
 * A session top-bar action runs outside the plugin view, then calls
 * `ctx.app.openView("paths")`, which may mount the view after the action returns.
 * A module-level pending target bridges that gap without a second backend read:
 * the Path Hub consumes it on mount, and a mounted hub receives it live through
 * `subscribePathHubTarget`. The value is navigation intent only, never data.
 */
export interface PathHubTarget {
  readonly pathId: string;
  readonly nodeId: string;
}

let pending: PathHubTarget | null = null;
const listeners = new Set<(target: PathHubTarget) => void>();

/** Record where to go and notify a hub that is already mounted. */
export function requestPathHubTarget(target: PathHubTarget): void {
  pending = target;
  for (const listener of [...listeners]) {
    try {
      listener(target);
    } catch {
      // A listener failing must not block navigation or the other listeners.
    }
  }
}

/** Take (and clear) the pending target once; a later mount does not re-navigate. */
export function consumePathHubTarget(): PathHubTarget | null {
  const target = pending;
  pending = null;
  return target;
}

export function subscribePathHubTarget(
  listener: (target: PathHubTarget) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test/lifecycle reset; not used by production navigation. */
export function clearPathHubTarget(): void {
  pending = null;
  listeners.clear();
}
