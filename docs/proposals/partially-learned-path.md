## Partially learned paths from selected chats (experimental proposal)

Status: proposal only. Refs [#12](https://github.com/kerr-mwv/learning-path-plugin/issues/12). This document does not add runtime behavior and does not block the merged graph-tutoring work or PR #11.

## Problem

The Architect can already use an uploaded PDF or UTF-8 text source, but a learner may also have relevant prior work in existing LearnHarness chats. Today the Architect cannot deliberately say, “these conversations are evidence that parts of this new path may be familiar.” As a result, a new path starts indistinguishably from a path for a complete beginner.

The intended meaning is **partially learned**, not mastered:

- some material may be familiar;
- the learner's current knowledge is uncertain or stale;
- the path should probe before deciding whether to reinforce or teach from scratch;
- selecting a chat must never skip the probe or mark a node consolidated.

## Proposed first slice

Let the Path Architect inspect a bounded list of native chats and choose some as prior-learning evidence when creating a new path.

```text
Architect
  list selectable chat metadata
    title, kind, dates, message count
    existing Learning Path/node associations, when present
  learner/Architect selects chat ids
  save_learning_path(..., priorLearningChatIds)
    validate ids still exist
    persist prior-learning evidence on the new path
    leave every new node probeable/unconsolidated
```

The listing is metadata-only. The Architect must not receive full transcripts through this feature. If a chat is already attached to a Learning Path node, the listing may expose that association as context: path id/title and node id/title. That association is evidence about where the chat came from, not a claim that the learner mastered the node.

## What “partially learned” means in v1

The first slice records provenance and intent; it does not implement the decision policy yet.

- New nodes remain `unstarted` or another explicitly supplied non-consolidated state; chat selection never creates `consolidated` state.
- No unit is skipped, reordered, compressed or auto-marked as known.
- Later work can use the evidence to ask a probe and record whether the learner still recalls the material, needs reinforcement, or needs a fresh explanation.
- Absence of selected chats means “no selected prior-chat evidence,” not “the learner knows nothing.”

## Existing source import

PDF/Markdown/UTF-8 import already exists in the plugin through the Architect upload control and the `sources.save`, `list_uploaded_sources` and `read_uploaded_source_chunk` tools. Selected chats should be a companion context source, not a replacement for file import and not a reason to retrieve transcript contents automatically.

## Data and safety boundaries

- Store only validated native chat ids and lightweight association metadata owned by the plugin; do not copy transcripts into path files.
- Revalidate selected ids at save time. If a chat was deleted, reject the save without changing the path.
- Read-only native chat listing; no chat mutation or deletion.
- No writes to the native Knowledge Graph, no mastery claims and no semantic equivalence/deduplication classifier.
- No automatic node↔chat matching in v1. The Architect chooses the evidence explicitly.
- No new probing scheduler or automatic progression policy in this slice.
- Existing paths and saves without prior-chat evidence retain their current behavior and representation as far as the schema allows.
- Keep this separate from learner-first relational-map revisiting (#10/#11).

## Acceptance for a future implementation

- [ ] The Architect has one bounded metadata-only tool for listing selectable chats.
- [ ] The listing distinguishes linked and unlinked chats and shows existing path/node associations without transcript text.
- [ ] A new path can include selected chat ids as prior-learning evidence.
- [ ] Unknown or deleted ids fail validation before any path write.
- [ ] Reading the path and Architect outline exposes the selected evidence without exposing transcripts.
- [ ] Selected evidence never marks nodes consolidated, skips nodes or changes progression automatically.
- [ ] Empty chat lists and existing save flows remain safe and compatible.
- [ ] Tests cover empty results, linked/unlinked metadata, deleted ids, persistence and no progression shortcut.
- [ ] A later behavior PR, separately scoped, demonstrates probe → reinforce → fresh-teach outcomes using real sessions.

## Decision requested

Is this the right first boundary for partially learned paths, or should chat selection remain deferred? A no means this proposal can be closed without runtime changes. If accepted, the implementation should start with metadata listing and explicit selected-id persistence—not transcript retrieval or the probe policy itself.
