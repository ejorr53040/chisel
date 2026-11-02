# 2. Pinned blocks are obstacles after ELK, not ELK constraints

Date: 2026-11-02 · Status: accepted

## Context

The canvas lays itself out live (#41): blocks never overlap, children stay inside their containers, and a block the
user drags stays exactly where it was dropped ("pinned"). Layout uses ELK's layered algorithm through elkjs (pinned to
0.12.0), which handles nested containers and orthogonal routing.

A probe on 2026-11-02 showed that layered ignores a node's given `x`/`y`, with or without `elk.interactiveLayout` and
the semi-interactive crossing minimisation: those options keep the *order* of nodes, not their coordinates. No layered
option holds an exact position inside a nested container.

## Decision

`layoutBoard` runs ELK on the whole board, then settles each container's children, innermost first:

1. Pinned children go back to their stored position, exactly.
2. Unpinned children, in ELK's top-to-bottom order, move straight down until they clear every block already placed
   (pinned or not) by the layout gap.
3. The container grows to hold everything it now contains.

Edges between a block and its own container are left out of ELK's input: nesting already shows ownership, and ELK
cannot route them.

## Consequences

- Pins are exact, and the property tests check it, along with no sibling overlap and children inside parents.
- Near pins the layout is less tidy than pure ELK: displaced blocks stack below their obstacle instead of being
  re-layered. Edges ELK routed around the old positions are stale for moved blocks; #42 routes edges from the final boxes.
- Two pinned siblings may overlap; the user placed them there, and layout doesn't move pins.
- A version-1 board opens fully pinned (migration), so nothing moves until the user unpins.
