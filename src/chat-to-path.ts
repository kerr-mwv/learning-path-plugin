/** Approval uses the exact staged path from committed managed-agent history. */
import type { PluginAgentSnapshot } from "learnharness-plugin-api";
import type { LearningPath } from "./domain.ts";

export const CHAT_PATH_ARCHITECT_ID = "teaching-chat-path-architect";
export const CHAT_PATH_FOLLOW_UP = "What would you like to study next? Tell me what you want to be able to do and any sources or constraints I should consider.";

export interface ChatPathProposal {
  readonly path: LearningPath;
  readonly baseRevision: string | null;
}

export function reviewableChatPath(snapshot: PluginAgentSnapshot | null):
  { readonly toolCallId: string; readonly proposal: ChatPathProposal } | null {
  if (snapshot?.definitionId !== CHAT_PATH_ARCHITECT_ID || snapshot.status !== "idle") return null;
  let userTurns = 0;
  let proposal: ReturnType<typeof reviewableChatPath> = null;
  for (const message of snapshot.messages) {
    if (message.role === "user") {
      userTurns++;
      proposal = null;
    } else if (userTurns >= 2 && message.role === "toolResult" &&
      (message.toolName === "save_learning_path" || message.toolName === "save_learning_path_json")) {
      const staged = message.details as ChatPathProposal | undefined;
      if (!message.isError && staged?.path) proposal = { toolCallId: message.toolCallId, proposal: staged };
    }
  }
  return proposal;
}
