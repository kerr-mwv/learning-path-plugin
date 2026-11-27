/** Native tool names shared by the backend bridge and the frontend renderers.
 *
 * Pure runtime constants only: both bundles import this module, so it must not
 * touch Node built-ins, the store or browser globals.
 */
export const LEARNING_PATH_TOOL_NAMES = [
  "learning_path_get_brief",
  "learning_path_update_progress",
  "learning_path_log_error",
  "learning_path_suggest_pivot",
  "learning_path_read_workspace_item",
  "learning_path_save_artifact",
] as const;

export const GRAPH_SEARCH_TOOL_NAME = "learning_path_search_graph";

/** Pivots proposed from a child session are limited to surgical repairs. */
export const CHILD_PIVOT_TYPES = ["bridge", "contrast", "skill"] as const;
