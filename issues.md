# Outstanding issues

Status as of commit `c2e574d` plus working-tree edits.

The four-layer pipeline (generation → clustering → neighbourhoods + taste +
sampling → hybrid spring force) is working correctly. The user-facing
levers (α, citation density / intra / cross, k-NN sliders, the citation
modal, base/citation edge controls) all behave as the math reference
(`doc/dynamics.md`) describes.

The first major debug-overlay pass shipped in `c2e574d` and the visual
sanity check that followed confirmed everything except mutual k-NN edges
behaves as expected. This file now tracks the remaining real issues plus
a wishlist.

---

## Inventory: every Debug ▾ toggle

The Debug menu currently exposes **eight** checkboxes, grouped by layer:

### Generation

1. **show origin markers** — `dbg-origins`
   `buildDebugGraph` injects N graph nodes with `id = "origin:N"`,
   `kind = "origin"`, `fx/fy/fz` pinned to the origin's centre.
   `nodeThreeObject` swaps the default sphere for the
   crosshair-in-octahedron gizmo.

2. **origin → node edges** — `dbg-origin-edges`
   Requires (1). Adds one link per data node from `node.id` to
   `"origin:N"`, coloured by origin.

3. **bounding cube** — `dbg-volume`
   Adds/removes a wireframe `THREE.Group` directly on `Graph.scene()`
   via `ensureVolumeOutline()`.

### Clustering

1. **cluster centroids** — `dbg-centroids`
   Graph nodes with `id = "centroid:N"`, `kind = "centroid"`, pinned to
   the cluster centroid. `nodeThreeObject` swaps in a wire-tetrahedron
   gizmo.

2. **mutual k-NN edges** — `dbg-mutual-edges`
   Graph links between integer-ID data nodes for every mutual k-NN pair
   found by the clustering layer. Coloured `#5dd39e`.
   **Behaviour issue — see "Mutual k-NN edges" below.**

### Physics

1. **citation tension** — `dbg-tension-cit`
   Citation edges colour-mapped from the live tension cache. The force
   writes `s · (d − ℓ)/d` per pair every tick; magnitude up to
   `MAX_TENSION = 5` so cited springs at α=5 still have headroom.

2. **base tension** — `dbg-tension-base`
   Same as (1) but for visible base edges.

3. **displacement** — `dbg-displacement`
   Line from each data node's live position to its frozen `basePos`,
   coloured by displacement magnitude. **Kabsch-aligned** via Horn's
   quaternion method (Jacobi 4×4 eigendecomp) so accumulated rigid
   translation + rotation drift across α sweeps does NOT show as false
   deformation — only genuine non-rigid residual is drawn.

---

## Mutual k-NN edges — needs a fresh hypothesis

The current overlay isn't doing what we want. The previous theories in
this file (edges follow live physics vs anchored at basePos) didn't
match what the user observed and have been removed. **To be rewritten
from scratch in the next pass.**

---

## Wishlist

Not bugs. Picked up here so they're not forgotten:

- Persist app state to JSON (the v1 File ▾ menu had this; currently
  stubbed out in our shell).
- "Cluster taste" debug visualisation: arrows between cluster centroids
  showing which clusters are in T(c) for each c. Would make the staged
  citation model legible at a glance.
- Neighbourhood overlay: draw a soft hull or sub-coloured halo per
  neighbourhood. Would make sparse-cluster-many-Ng cases obvious.
- Single-click a node → highlight its citations + its neighbourhood.
  Tooltips already show some of this; click-to-pin would help during
  presentations.
- Live performance work: the inner-loop force is O(n²) per tick. Fine
  at n=100; would chug at n=1000+. Not a problem until it is.
