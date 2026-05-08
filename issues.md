# Outstanding issues

Status as of v3 stage 4 (`088befb`).

The v3 pipeline (generation → clustering → citations → citation
layout → blend) works end-to-end. The blend slider is deterministic
and round-trip exact. The Citation Layout ▾ modal exposes FR's
`iterations` and `tBias` knobs. Citation generation, clustering, and
citation layout are each behind their own registry — adding a new
algorithm to any of them is an entry, not a rewrite.

---

## Debug ▾ inventory (v3)

Three sections in the menu, six checkboxes:

### Generation

1. **show origin markers** — `dbg-origins`
   Injects gizmo nodes (`kind = "origin"`, pinned via fx/fy/fz to the
   origin centre).
2. **origin → node edges** — `dbg-origin-edges`
   Requires (1). One link per data node back to its origin gizmo.
3. **bounding cube** — `dbg-volume`
   Wireframe `THREE.Group` outlining the working volume.

### Clustering

1. **cluster centroids** — `dbg-centroids`
   Gizmo nodes pinned to each cluster's centroid.
2. **structure edges** — `dbg-structure-edges`
   Algorithm-specific structural edges (mutual-k-NN edges; HDBSCAN's
   condensed-tree backbone; etc.). Each cluster algorithm decides
   what to expose via its `structureEdges` output field.
3. **noise rings** — `dbg-noise-rings`
   Halo on nodes the algorithm classified as noise (HDBSCAN only).

### Blend / displacement

1. **displacement** — `dbg-displacement`
   Line from each data node's `live` position to its `basePos`.
   Under the v3 blend, displacement = `α · (alignedCitationPos −
   basePos)` exactly — a known function of α. The overlay's
   per-frame Kabsch alignment is now redundant (alignedCitationPos
   is already aligned per-component to basePos at compute time);
   it costs a 4×4 eigendecomp per frame and produces an identity
   transform. Cleanup is wishlist material, not a bug.

---

## Wishlist

Not bugs. Picked up here so they're not forgotten:

- **Stress-tracking overlay.** Per-edge "how much does this edge
  distort at the current blend value" colouring. Would let the user
  find α values where the topology transition is gentle vs violent.
- **Optimal transition state.** Instead of pure linear lerp through
  configuration space, precompute one or more midpoint arrangements
  that minimise max-stress along the path. Piecewise-linear blend
  through them. See `doc/v3-plan.md` "Future work."
- **Inter-component spacing pass** in `blend/align.js`: after
  per-component Kabsch, push overlapping components apart along the
  vector between centroids. Defer until two components actually
  collide visually in normal use.
- **More citation-layout algorithms.** Spectral (graph Laplacian
  eigenvectors), hierarchical tree-by-`t`, MDS on graph distances.
  Easy adds — register an entry, the modal renders from
  `modalSchema` automatically.
- **More citation-generation algorithms.** Random Erdős–Rényi,
  preferential attachment, time-ordered DAG. Same registry pattern.
- **Persist app state to JSON.** The v1 File ▾ menu had this;
  currently stubbed out in our shell.
- **Cluster taste debug visualisation.** Arrows between cluster
  centroids showing which clusters are in `T(c)` for each `c`.
  Makes the layered citation generation legible at a glance.
- **Live performance work.** FR is `O(iterations · n²)` per
  recompute; alignment is `O(n + |E|)`. Fine at `n = 400`; would
  benefit from Barnes-Hut for the FR repulsion at `n = 1000+`.
- **Click-to-pin a node.** Highlight its citations + neighbourhood
  on click; tooltip already shows some of this.
