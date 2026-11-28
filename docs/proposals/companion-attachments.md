# Companion-provided node attachments

Status: proposal only. Refs #24.

## Build on Companion API v1

[Companion API v1](../companion-api.md) already gives other plugins stable path and node IDs and a read-only view of Learning Path data. Keep that reader unchanged. Add an optional, versioned attachment offer format so companions can populate a list of candidate attachments without getting write access to the Learning Path store.

## Example: `learnharness-wikipedia`

[`learnharness-wikipedia`](https://github.com/GGabrielDev/learnharness-wikipedia) already produces Markdown attachments for ordinary LearnHarness chats. For a node on plate tectonics, it could offer an article or selected sections with their article URLs, revision links when available, and attribution. The learner previews the material in Learning Path and chooses which pieces to attach to the node. Learning Path does not perform the lookup, depend on Wikipedia, or automatically feed the material to the tutor.

## Proposed first pass

1. A companion uses the existing reader to identify a destination, then exports a bounded attachment package from its own workflow. Start with a single versioned JSON document containing the target `pathId` and `nodeId`, a producer label/ID, and Markdown entries with producer-scoped stable IDs, titles, and optional source and attribution metadata. Inline content avoids resolving companion-supplied local paths.
2. Behind a default-off setting, Learning Path offers an explicit import and preview. It validates size, version, fields, and the target before allowing the learner to select entries. Show the destination and declared source in the preview; a producer ID in an imported document is not proof of identity.
3. On confirmation, Learning Path checks the destination again and saves the selected items through its existing workspace operations, linked to the node. Preserve attribution and ignore exact repeats for the same destination; never silently overwrite learner-edited material. Importing does not start a session or change progress.
4. Keep session handoff separate from import. If the public SDK supports passing selected workspace material as native attachments to a Teaching or Practice session, offer that as an explicit learner action. Otherwise ship the node attachment flow without native handoff; no private composer hooks.

A file import is a starting point because LearnHarness plugin API v1 does not expose cross-plugin calls. A future host-mediated handoff can reuse the offer format. Neither transport should let a companion mutate Learning Path records directly or make Learning Path scan sibling directories.

## What to verify before implementation is ready

- An example offer with Wikipedia Markdown imports to the selected node and retains the source and attribution. The node still has its imported material after the companion is disabled.
- Cancelling or rejecting an import leaves the workspace unchanged. Invalid or oversized packages and offers for deleted nodes return actionable errors. Re-importing the same entry does not duplicate it.
- The existing Companion API v1 reader and demo work unchanged. With the feature off, no import action appears.

## Feedback requested

Is the node workspace the right first destination? Is explicit package import an acceptable starting point under the current SDK, or should the attachment handoff wait for a public host bridge?
