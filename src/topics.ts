/** Live notification topics shared by the backend and the Path Hub view.
 *
 * This module is deliberately pure: both bundles import it, so it must never
 * pull in Node built-ins or browser globals. Notifications are live hints only;
 * consumers refetch authoritative state (`paths.get`, `architect.get`) on receipt
 * and after `ctx.onResync`.
 */
import type { PluginAgentSnapshot } from "learnharness-plugin-api";

export const EVENT_PATHS_CHANGED = "paths-changed";
export const EVENT_SOURCES_CHANGED = "sources-changed";
export const EVENT_ARCHITECT_CHANGED = "architect-changed";
export const EVENT_SETTINGS_CHANGED = "settings-changed";

/** `architect.progress` result: one conversation's live state without its
 * committed history, so stream ticks do not resend the whole conversation.
 * `messageCount` tells the view whether its cached history is still current. */
export interface ArchitectProgress {
  id: string;
  status: PluginAgentSnapshot["status"];
  error?: string;
  pending: PluginAgentSnapshot["pending"];
  updatedAt: string;
  messageCount: number;
  partial?: PluginAgentSnapshot["partial"];
}
