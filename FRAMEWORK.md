# Learning Path Framework & Glossary

This document defines the pedagogical framework that governs how the **Learning Path Plugin** constructs paths, structures study units, tracks epistemic progress, and guides LearnHarness agents during both path design and topic sessions.

---

## 1. Core Philosophy

Most self-directed learning fails in one of two ways:
1. **Unstructured wandering:** Jumping between disconnected tutorials, chats, or videos without an overarching dependency map—producing isolated fragments of familiarity that never lock together.
2. **Rigid, unvalidated syllabi:** Asking an LLM to "generate a study plan," which frequently hallucinates muddled topic sequences, omits subtle prerequisites, Invents arbitrary hour/day schedules, and mistakes *reading explanations* for *durable understanding*.

The Learning Path Framework solves both problems by separating **macro-curriculum architecture** (the Path) from **first-principles instruction and practice** (child LearnHarness sessions), connected by a lightweight diagnostic loop of progression states, error watchpoints, and multi-level interleaving.

---

## 2. Framework Principles & Design Justifications

### Principle 1: Canonical Source Grounding ("No Hallucinated Curricula")
Every learning path must be anchored to an explicit **Source Spine**:
- **Established Canon Mode:** Grounded in 1–2 reputable textbooks, university courses, or authoritative specifications (e.g., *Axler* vs. *Strang* for Linear Algebra; *OSTEP* for Operating Systems; *CLRS* for Algorithms), with explicit chapter/section references attached to every node.
- **User-Supplied Corpus Mode:** Built directly from a book, syllabus, or paper uploaded by the learner (converted locally via `ctx.documents.toMarkdown`), bringing in external canonical references only when needed to patch missing prerequisites.

**Why we chose this:**
> Classic textbooks and battle-tested courses represent decades of refined pedagogical sequencing: their authors have already discovered which definitions must precede which theorems, where notation breaks down, and which counterexamples prevent standard traps. Prompting an LLM to invent a curriculum from scratch discards that accumulated craft and risks subtle dependency inversions. Anchoring to canon keeps notation coherent and gives the learner a trustworthy external reference outside chat.

---

### Principle 2: Proactive Six-Type Node Taxonomy

Our framework uses **six distinct node types**:
1. **Holistic (`holistic`)** — Structural maps, links, and system-level relationships *between* ideas.
2. **Isolated Concept (`concept`)** — Deep, first-principles understanding of one load-bearing idea or mechanism.
3. **Contrast (`contrast`)** — Explicit boundary discrimination between confusable concepts or competing approaches.
4. **Skill (`skill`)** — Brief procedural tricks, idioms, heuristics, or mechanical fluencies.
5. **Integrative Checkpoint (`checkpoint`)** — Multi-topic synthesis problems where relevant tools are *not* pre-labeled.
6. **Bridge (`bridge`)** — Surgical, bounded repair of a missing upstream prerequisite.

**Why `holistic` and `contrast` are proactive (not merely reactive):**
> Learners often study Concepts A, B, and C cleanly in isolation yet fail in practice because they never built the macro-schema connecting them (`holistic`), or because Concept A and Concept B share surface features that trigger false pattern-matching (`contrast`). Weaving `holistic` and `contrast` nodes directly into the baseline path—wherever structural synthesis or boundary confusion naturally arises—prevents misconceptions before they calcify, rather than waiting for failure.

---

### Principle 3: Conservative, Advisory-Only Path Adaptation
Paths should feel **stable, legible, and predictable**—not like shifting sand that reorganizes itself behind the learner's back after every turn.

- **When adaptation triggers:** Dynamic path changes are considered **only when a topic genuinely isn't sticking** for a specific diagnosed reason:
  - *Upstream Prerequisite Gap* $\rightarrow$ suggest inserting a bounded **Bridge** node.
  - *Persistent Boundary Confusion* $\rightarrow$ suggest inserting a **Contrast** or **Holistic** node.
  - *Mechanical Bottleneck (high cognitive load on execution)* $\rightarrow$ suggest spawning a focused **Skill** node.
- **Suggest, never enforce:** Agents never silently rewrite or reorder the path. They surface a clear, non-intrusive **Pivot Suggestion** explaining *what isn't sticking and why*, which the learner can accept, refine with the Path Architect, or dismiss.

**Why we constrained dynamic adaptation:**
> Aggressive "adaptive curricula" frequently overreact to single mistakes, yank learners onto endless prerequisite detours, and destroy their sense of momentum and map orientation. Preserving learner agency—while still catching genuine walls when a concept refuses to stick—keeps the canonical spine trustworthy.

---

### Principle 4: Self-Directed Light Pre-Reading & Loose Micro-Priming
Rather than running heavy agent-led "macro-priming sessions" before every module, priming operates with a light touch at two levels:

1. **Self-Directed Light Pre-Reading (Replacing Macro-Priming Chats):**
   - Modules and nodes provide brief pointers for independent orientation before deep study (e.g., *"Skim the Wikipedia overview of Eigenvalues for 5 minutes"* or *"Lightly read Ch. 3 §3.1 without worrying about the proofs yet"*).
2. **Loose Micro-Priming (Inside Topic Chats):**
   - When opening a topic session, the agent may pose a quick motivating puzzle, concrete phenomenon, or intuition prediction ("What goes wrong if we try the naive approach here?") before formalizing definitions.
   - Priming is a **loose recommendation, never a mandatory gate**.

**Why we dropped macro-priming chats and priming gates:**
> Turning initial exposure into another formal AI dialogue adds friction and ceremony where a 5-minute skim of Wikipedia or a chapter introduction works faster and builds independent research habits. Making priming optional respects learners who already have context (or simply want to dive straight in) while keeping cognitive "velcro hooks" available for unfamiliar territory.

---

### Principle 5: Multi-Level Interleaving (Micro, Meso, Macro)
Blocked practice (studying AAA, then BBB, then CCC in sealed compartments) inflates short-term performance because the learner already knows which formula or concept applies on every problem. Real understanding requires **strategy selection**—recognizing which mental model applies *without* a chapter heading telling you.

Interleaving is applied across **three nested scales**:
- **Micro-Level (Within a Session):** Mixing edge cases, non-examples, and problem variations inside a single topic chat or practice session.
- **Meso-Level (Across Node Types & Recent Nodes):** Alternating between node modalities (`holistic` $\rightarrow$ `concept` $\rightarrow$ `skill` $\rightarrow$ `contrast`) and deliberately pulling concepts from Nodes $N-1, N-2$ into the examples and artifacts of Node $N$.
- **Macro-Level (Spiral & Checkpoints):** Placing periodic **Integrative Checkpoints** across modules where problems blend multiple prior concepts without naming them, and revisiting foundational ideas at deeper layers of abstraction later in the path.

---

### Principle 6: Configurable Generative Artifacts with Transparent Justifications
Reading a clear explanation or nodding along in chat creates a powerful **illusion of competence**: recognition fluency feels identical to mastery until you face a blank page. Producing a concrete external **artifact** forces generative retrieval, structural organization, and precision.

Because learners and domains vary widely, artifacts are **configurable** (globally in Settings, per-Path, and per-Node, including `"None / Conversation-only"`), and the UI explicitly states *why* each artifact type is recommended:

| Artifact Type | Best Suited For | Pedagogical Justification |
| :--- | :--- | :--- |
| **Micro-Code / Implementation** | Algorithms, math, CS, systems | *Eliminates hand-waving: an interpreter, compiler, or test case exposes hidden assumptions and edge-case gaps immediately.* |
| **Relational Map / Diagram** | `holistic`, `contrast` | *Externalizes mental structure: forcing explicit node-and-edge labels reveals whether you understand actual causal/logical links or merely know two terms are "related."* |
| **Encoding / Compression Exercise** *(Feynman blank-page, compare/contrast matrix, counterexample design)* | `concept`, `contrast` | *Harnesses the generation effect: reconstructing and compressing an idea in your own words creates durable retrieval pathways that passive review cannot.* |
| **Derivation / Worked Trace** | `concept`, `skill` | *Verifies step-by-step causal continuity without relying on the textbook's visual scaffolding.* |
| **Retrieval Cue / Flashcard Seed** | Definitions, `skill` | *Crystallizes atomic hooks and heuristics *after* comprehension is established so tactical fluency stays sharp.* |

---

### Principle 7: Ungated Epistemic Progression & Error Watchpoints (Zero Scheduling)
- **Strict Non-Goal — No Time/Calendar Scheduling:** The framework never prescribes *"Study 2 hours on Mon/Wed/Fri,"* countdown timers, streaks, or completion dates. Learning speed varies nonlinearly with prior knowledge and concept density; artificial time boxes encourage superficial skimming to "stay on schedule."
- **Simple, Ungated Progression States:**
  - `unstarted` $\rightarrow$ `in_progress` $\rightarrow$ `consolidated`
  - Learners can jump into any node at any time without artificially locked trees.
- **Structured Error Ledger as Forward Watchpoints:**
  - Mistakes and friction points in child sessions are logged by **cognitive root cause** (`misconception`, `discrimination_error`, `prerequisite_gap`, `procedural_slip`, `cue_failure`) rather than numeric grades.
  - Unresolved errors remain visible on the node and travel forward as **watchpoints** into future interleaved sessions so the agent can quietly verify whether the repair actually held.

---

## 3. Glossary of Terms

### Path Structure & Grounding

- **Learning Path:** A persistent, tree-structured curriculum workspace centered on a specific learning goal, anchored to reputable source material, and serving as the parent hub from which topic study and practice chats are launched.
- **Path Architect:** The plugin-managed conversational agent (`ctx.agents`) used when pressing **"Create a Path"** (or refining an existing path). It clarifies goals and background, selects or ingests the canonical source spine, and emits the structured path.
- **Canonical Source Spine:** The primary authoritative textbook(s), university course(s), specification(s), or learner-uploaded corpus that govern the path's conceptual ordering, notation, and section anchors.
- **Source Anchor:** The specific chapter, lecture, section, or page range in the Canonical Source Spine associated with an individual node (e.g., *OSTEP Ch. 26–27*).
- **Child Session:** A native LearnHarness **Teaching** or **Practice** chat linked beneath a specific Path Node. Child sessions inherit a tailored brief from their parent node and report progression, errors, and non-stick pivot suggestions back to the Path.

### Node Types

- **Holistic Node (`holistic`):** A study unit dedicated to macro-structure—how concepts fit into a single coherent architecture, why a domain decomposes the way it does, and how ideas transform or flow into one another.
- **Isolated Concept Node (`concept`):** A study unit focused on a single load-bearing principle, theorem, mental model, or mechanism, aiming to make it feel *obviously true* from first principles before combining it with other moving parts.
- **Contrast Node (`contrast`):** A study unit explicitly juxtaposing two or more easily conflated ideas (e.g., *concurrency vs. parallelism*, *covariance vs. correlation*, *L1 vs. L2 geometry*) to sharpen the exact boundary conditions separating them.
- **Skill Node (`skill`):** A brief, tactical unit targeting procedural fluency, pattern-recognition shortcuts, idioms, or mechanical manipulations. Automating low-level skills frees working memory so it isn't bottlenecked during complex conceptual reasoning.
- **Integrative Checkpoint (`checkpoint`):** A synthesis milestone spanning multiple earlier nodes where problems are presented *without* labels indicating which concept or skill to use—testing transfer and strategy selection.
- **Bridge Node (`bridge`):** A short, surgical detour inserted (with learner approval) to patch a specific missing upstream prerequisite discovered mid-path, returning immediately to the main spine once resolved.

### Cognitive Mechanisms

- **Light Pre-Reading:** Brief, low-pressure, self-directed exposure to a topic *outside* AI chat before deep study—such as skimming a Wikipedia article, reading chapter headings/summaries, or browsing an introductory section—to establish rough vocabulary and orientation.
- **Micro-Priming:** A lightweight conversational hook at the start of a topic chat (such as predicting an outcome, inspecting a puzzling failure case, or stating initial intuition) that activates prior mental models before formal definitions are introduced. Loose and recommended, never mandatory.
- **Interleaving:** Deliberately mixing related concepts, node modalities, and problem types rather than studying each in an isolated block. Forces the brain to practice *discriminating context and choosing the right mental model*, not merely executing the last-seen procedure.
  - **Micro-Interleaving:** Varying problem structure, edge cases, and non-examples within a single session.
  - **Meso-Interleaving:** Alternating node types (`holistic` / `concept` / `skill` / `contrast`) and weaving concepts from recent prior nodes ($N-1, N-2$) into the examples and exercises of the current node ($N$).
  - **Macro-Interleaving:** Revisiting core ideas across modules at deeper abstraction levels (spiraling) and testing mixed, unlabelled synthesis inside **Integrative Checkpoints**.
- **Illusion of Competence:** The cognitive trap in which understanding an explanation *while looking at it* (passive recognition fluency) is mistaken for the ability to generate, apply, or reconstruct the idea independently.
- **Generative Artifact:** A tangible learner-produced output for a node (code snippet, relational diagram, blank-page compression note, proof trace, or retrieval cue) designed to pierce illusions of competence through active generation.

### Diagnostics, Progression & Adaptation

- **Consolidated (`consolidated`):** The terminal epistemic status of a node indicating that the learner understands why the concept holds, connects it to surrounding structure, and (if configured) has completed its artifact without unresolved blocking misconceptions.
- **Error Ledger:** A node-level diagnostic log capturing specific conceptual or procedural friction encountered in child sessions, classified into five root causes:
  - **`misconception`:** Holding an active, flawed mental model or false causal belief.
  - **`discrimination_error`:** Understanding two concepts individually but confusing when one applies versus the other.
  - **`prerequisite_gap`:** Struggling because an assumed upstream foundation is missing or shaky.
  - **`procedural_slip`:** Holding the right conceptual model while making mechanical, algebraic, or syntactic execution errors.
  - **`cue_failure`:** Possessing the knowledge once prompted by name, but failing to recognize its relevance in an unlabelled context.
- **Watchpoint:** An unresolved Error Ledger entry automatically injected into the agent brief of subsequent or interleaved sessions so the agent can test whether the difficulty has genuinely been overcome.
- **Advisory Pivot Suggestion:** A non-enforced proposal surfaced when a node genuinely isn't sticking, recommending an optional detour (such as a `bridge`, `skill`, or `contrast` node) that only alters the path if explicitly approved by the learner.
