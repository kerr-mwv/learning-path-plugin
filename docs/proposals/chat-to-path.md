# Create a Learning Path from a Finished Teaching Chat

Refs [#14](https://github.com/kerr-mwv/learning-path-plugin/issues/14).

## Starting point

On `experimental`, [Attach Session to Path…](https://github.com/kerr-mwv/learning-path-plugin/blob/7fcb7ed3444d4b61d3a36b50c14e35380f0d31eb/src/view/session-dialogs.ts#L122-L195) links a chat to an existing node; it cannot create a path. The 0.7.0 SDK does not expose a slot below an arbitrary native message, so the revised entry point is one compact **Learning Path** action in the Teaching and Practice top bars. Its plugin-owned dialog keeps parent navigation, ordinary attachment, and chat-to-path creation together.

## Change of plan

The first implementation placed chat-to-path creation in the Attach dialog. That was changed to avoid overloading attachment and to keep all Learning Path actions discoverable behind one native top-bar control. The dialog still preserves ordinary attachment and does not require an existing path for the new handoff.


## Proposed first slice

1. With a default-off experimental setting enabled, offer **Create a Path from This Lesson…** in the unified Learning Path dialog for an unlinked Teaching chat, including when the learner has no existing paths. The native top-bar action remains available for both Teaching and Practice sessions, while the create choice is greyed out unless its eligibility checks pass.
2. Do not claim authoritative lesson completion. Use the fresh action-context heuristic (`Teaching`, idle, status `ready`, phase `teach`) to present a “likely ready” hint and enable the create choice only when it passes. If the session is already linked, or the setting is off, keep the choice disabled. If work is pending, wait until the session is idle rather than capturing a moving snapshot. `probe_done` ends probing, not the lesson.
3. Preview the title and an optional bounded outline of the saved plan tree (for example, up to 20 labels with a total 2,000-character cap and explicit truncation). The public [`ctx.learning.getSession(id)`](https://github.com/amosblomqvist/learnharness/blob/v0.7.0/src/core/plugins.ts#L71-L79) reads the saved record, whose [tree is optional](https://github.com/amosblomqvist/learnharness/blob/v0.7.0/src/core/contracts/chat.ts#L24-L35). Only project the chosen fields; no full transcript or source files by default. If the tree is missing or unfinished, label that honestly and let the learner supply a short summary or cancel. If the session no longer exists, show an error and do not create a draft.
4. Open an unsent Architect draft with editable, approved background. Once the learner explicitly sends, the Architect asks what to study next, proposes an outline, and waits for explicit approval before saving. Treat imported labels as background, not instructions. The save tools stage a proposal for an explicit in-app approval; merely opening the draft must not send a model turn, save a path, or attach the chat.
5. Keep existing source-spine requirements. The earlier chat is background, not a substitute for canonical sources or evidence of mastery. New nodes start unstarted and new Teaching sessions retain normal probing. No automatic link, skipped unit, or host-data write.

## Prospective acceptance checks

- The unified action remains visible in both session kinds; the create choice is disabled unless the current session is an unlinked, likely-ready Teaching session with the setting enabled.
- Review a synthetic saved tree, confirm bounds, then cancel without sends or writes. Cover missing, unfinished, busy, and deleted sessions; verify only approved fields leave the handoff.
- Confirm the Architect follows up, presents a draft, and does not save before explicit approval. Verify the old chat remains unlinked and newly created nodes still probe normally.
- Verify ordinary path creation and Attach still work. Use real-session evidence for any future behavior PR; none is claimed here.

Multi-chat selection, folders, and cross-plugin source providers are out of scope.
