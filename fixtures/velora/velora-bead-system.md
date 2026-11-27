# The Velora bead system (synthetic test fixture)

> This is an invented system. It exists only to exercise the LearnHarness
> Knowledge Graph and the Learning Path graph-informed tutoring feature. It is
> not a real physical or mathematical theory.

Velora is a toy system with two sealed chambers, a **left** chamber and a
**right** chamber. A *state* is a pair `(L, R)` of non-negative integers: the
number of beads in each chamber. A **Velora state** is therefore an ordered
pair of bead counts.

## Operations

There are exactly two operations.

1. **Transfer.** Move one existing bead from one chamber to the other. If the
   bead moves left to right, the state changes from `(L, R)` to `(L - 1, R + 1)`.
   If it moves right to left, the state changes from `(L, R)` to
   `(L + 1, R - 1)`. A transfer creates no bead and destroys no bead, so the
   combined bead total `T = L + R` is unchanged.
2. **Creation pulse.** Add one new bead to the left chamber. The state changes
   from `(L, R)` to `(L + 1, R)`. A creation pulse raises the combined bead
   total by exactly one.

No operation removes a bead from the system.

## Consequences worth noticing

- **Total invariance.** Under any sequence of transfers, the combined bead
  total stays equal to its initial value.
- **Pulse signature.** A creation pulse raises the combined total by one.
- **Pulse detection.** If the combined total rises between two Velora states,
  at least one creation pulse occurred. Transfers alone cannot explain the
  rise.
- **The same left count.** A right-to-left transfer and a creation pulse both
  raise the left count by one. They differ in what happens to the combined
  total: the transfer leaves it unchanged, the pulse increases it.
- **Reachability by transfers alone.** From `(L0, R0)`, transfers alone reach
  exactly the states `(L0 + k, R0 - k)` for integers `k` with
  `-L0 <= k <= R0`.

## A worked pair

Start at `(7, 5)`, so `T = 12`.

- After two transfers, the state could be `(5, 7)` or `(9, 3)`; both still have
  `T = 12`.
- After one creation pulse and one transfer, the state could be `(7, 6)` with
  `T = 13`. The total rose, so a pulse occurred.
- The state `(7, 6)` cannot be reached from `(7, 5)` by transfers alone,
  because its combined total differs.
