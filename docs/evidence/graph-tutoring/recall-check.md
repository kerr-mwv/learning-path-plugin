# Supplemental live evidence: genuine recall before supplying the rule

This additional fresh native Practice session closes the distinction between reasoning from supplied definitions and **recalling an entry from prior study**. The earlier first problem supplied operation definitions and is not, by itself, evidence of prior-memory recall.

Actual model output was captured from the isolated LearnHarness 0.6.1 host. Learner prompts/submissions below are **automated synthetic inputs**, not a human-learning study. Backend SHA256: `87b7cfa28f8656d435f8866adef60379c8fe52a71fbe6b1b2e4cafd89c1a8111`. No code changed for this supplement.

## Provenance and ordering

- The unit title/source anchor was “Velora”; its launch prompt contained no graph propositions, operation definitions, or invariant.
- The first actual agent turn called `learning_path_get_brief` and then `problem`, with **no native graph readers, file reads or search/background calls**.
- The private brief returned five synthetic Velora graph entries from the previously imported fixture. Both problem target IDs were among those retrieved entries. These IDs and tool-response contents stay private.
- The learner's opening said only that they remembered studying Velora, not what its operations meant. The agent asked what a transfer does to counts **without defining transfer or stating the invariant first**. The hidden model solution was not displayed to the learner.
- The later learner attempt was submitted through the native practice thinking event. Only afterward did native `conclude` confirm the recalled rule.

## Exact captured exchange

**Automated learner, appended to graph-free launch prompt:**

> I remember studying Velora before, but may have forgotten it. Before relying on my prior study, check what I remember without restating the notes first. Wait for my attempt before giving feedback.

**Practice, native problem statement:**

> Two sealed Velora chambers contain $5$ beads on the left and $7$ on the right. One **transfer** occurs. What bead counts could the chambers have afterward, and what happens to their combined count? Answer from memory, without consulting your notes.

**Automated learner, subsequent submitted attempt:**

> From memory, a transfer relocates one existing bead between the chambers. So either (4,8) or (6,6), depending on direction, and both totals stay 12.

**Practice, native conclusion after the attempt:**

> Correct. You recalled that a transfer relocates one existing bead, enumerated both directions, and kept the combined count at $12$.

**Practice, subsequent prose:**

> Your answer covers both possible transfer directions and the unchanged total.

The question supplies initial counts and names the previously studied operation but does not reveal its definition, legal resulting pairs, or unchanged total. Those are produced by the automated learner's response and confirmed afterward. This is one observed successful recall check, not a claim of universal model adherence or measured learning effectiveness. No incorrect-link or adversarial case is claimed.
