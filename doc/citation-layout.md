# Citation-driven layout

This document is the math + algorithm reference for Layer 4 of v3
(citation-layout) and the alignment step that lives in Layer 5
(blend). The two together produce `alignedCitationLayout`, the α=1
endpoint of the blend described in `dynamics.md` §4.

The defining constraint is encapsulation:

- The **layout module** (`app/src/citation-layout/`) sees only the
  citation graph + per-node timestamps + a layout seed. It does not
  see basePos, clusters, or how citations were generated.
- The **alignment module** (`app/src/blend/align.js`) is the only
  place in the codebase where citationPos and basePos meet.

Two-stage pipeline:

```
citation graph + t + seed
    │
    ▼
citation-layout/fr.js       →  citationPos      (FR equilibrium)
    │
    ▼
blend/align.js              →  alignedCitationPos
                                (per-component Kabsch
                                 alignment to basePos)
```

---

## 1. Layout: Fruchterman–Reingold in 3D

`app/src/citation-layout/fr.js`. Standard FR in 3D with two additions:
a **time-axis radial anchor** that biases older nodes toward the
centre, and a **hard outer wall** that prevents pathological
self-repelling clouds (sparse graphs with many isolated nodes) from
inflating without bound.

### 1.1 Forces

Let `n` be the node count, `R = worldR` the working half-extent
(default 60, matching basePos), and

```
k  =  (volume / n)^(1/3)              volume = (2R)³
```

`k` is the FR ideal edge length. Connected pairs equilibrate at
`d = k`; disconnected pairs equilibrate at infinity (held back by
repulsion and the anchor).

Each iteration accumulates three force contributions per node:

#### Repulsion (every pair)

For every unordered pair `(i, j)`:

```
f_rep(d)  =  k² / d
```

Direction: from `j` toward `i`, applied with opposite sign on `j`.
For `d` near zero we kick the pair apart with a tiny random direction
so future iterations have a usable gradient.

#### Attraction (citation edges only)

For every edge `(u, v)` in the citation graph:

```
f_att(d)  =  d² / k
```

Direction: from `u` toward `v`, opposite sign on `v`. Citation edges
are treated as undirected — t-ordering is folded into the radial
anchor, not the attraction.

#### Time-axis radial anchor (Hooke's law toward origin)

For every node `i`:

```
ka_i      =  max(T_FLOOR, 1 − t_i) · tBias       (T_FLOOR = 0.2)
f_anchor  =  ka_i · |position_i|                 toward origin
```

Force linear in radius. This is what gives the layout a cladogram
feel — older nodes (low `t`) feel a stronger pull and end up more
central, younger nodes drift outward under repulsion. Floor at 0.2
keeps even `t = 1` nodes anchored enough that pure-repulsion runaway
is impossible.

The cladogram is **unrooted** — radial only, no privileged axis.
Time bias does not introduce any preferred orientation.

Hooke's law (linear in `r`) was chosen over a constant-magnitude
anchor because constant-magnitude is overwhelmed by repulsion sums in
many-isolated-node graphs — equilibrium becomes unbounded. Hooke
scales with `r`, so equilibrium is finite for any cloud size.

### 1.2 Cooling + clamp

Per-iteration max displacement decays linearly:

```
temp(iter)  =  R · initialTempFraction  +
               (R · finalTempFraction − R · initialTempFraction) · iter / (iters − 1)
```

with defaults `initialTempFraction = 0.20`, `finalTempFraction = 0.005`.
Each node's accumulated displacement is capped at `temp` before being
applied — standard FR cooling, prevents oscillation.

After applying displacement, every node is clamped to the outer wall:

```
wallR  =  R · outerWallFraction          (default 1.5)

if  |position_i|  >  wallR:
    position_i  ←  position_i  ·  wallR / |position_i|
```

The wall is a backstop. For connected, normally-cited graphs the
soft anchor handles equilibrium and the wall never activates. For
sparse graphs (e.g. citation density 0.05, 60% isolated nodes) the
self-repelling-cloud equilibrium is far outside `R`; the wall snaps
those nodes onto a peripheral shell at `r = wallR`.

### 1.3 Determinism + seeding

Initial positions are uniform in the cube `[−R/3, R/3]³`, sampled
with `mulberry32` seeded from the citation seed (XOR'd with a marker
constant so it doesn't accidentally collide with other seeded
modules). The full algorithm is byte-deterministic for a given
`(n, edges, t, seed, params)` tuple — same inputs always produce the
same `Float32Array` output.

### 1.4 Cost

`O(iterations · (n² + |E|))`. For `n = 400, iterations = 200,
|E| = 2500` that's around 32 M JS ops, runs in ~50 ms. Recomputed
only when the citation graph or layout params change — cached as
`state.citationLayout`.

---

## 2. Alignment: per-component similarity transform

`app/src/blend/align.js`. Takes basePos and the raw FR output and
produces `alignedCitationLayout` by applying an independent
similarity transform (rotation + uniform scale + translation) per
connected component.

### 2.1 Why per-component (not whole-graph)

A single transform across the whole graph forces a compromise:
two components whose basePos centroids are far apart, or whose
intrinsic densities differ, can't all be aligned simultaneously.
Per-component handles each independently:

- A component's **internal geometry** is dictated by FR. It carries
  topological information (which nodes cite which). We preserve it
  by applying a similarity transform — rotation × uniform scale ×
  translation only, no per-node deformation. Uniform scaling is a
  similarity transform, so angles and intra-component distance
  *ratios* survive intact; only absolute scale shifts.
- A component's **overall position, orientation, AND scale** are
  underdetermined by topology. We pick a translation + rotation
  that minimises RMSD to basePos and a scale that matches RMS norm.

### 2.2 Singletons

A degree-0 node is a singleton component. Per-component Kabsch on
one point is just translation: the node lands exactly at its basePos.

This is exactly the right answer for isolated nodes — they have zero
topological constraint, so their citation-layout position should
default to wherever basePos says they belong.

### 2.3 Algorithm (per component)

For each connected component with node ids `{i₀, i₁, …}`:

1. **Centroids**:
   ```
   c    =  Σ citationPos[i] / m
   bc   =  Σ basePos[i]     / m
   ```
2. **Cross-correlation** `S` (3×3, `a` = citationPos centred,
   `b` = basePos centred), plus the squared-norm sums:
   ```
   S_xy   =  Σ a_x b_y     etc.
   sumA²  =  Σ |a|²
   sumB²  =  Σ |b|²
   ```
3. **Horn's symmetric 4×4 matrix** `N` (entries built from the `S`
   sums; see `align.js` for the explicit construction). The
   eigenvector of N's largest eigenvalue is the unit quaternion of
   the optimal rotation that maps `a → b`.
4. **Eigendecomposition** via cyclic Jacobi (50 sweeps max,
   `1e-12` off-diagonal threshold). Pick the largest eigenvalue;
   normalise its eigenvector to a unit quaternion `(qw, qx, qy, qz)`.
   Build `R` from the quaternion (standard formula).
5. **Scale**:
   ```
   s  =  √(sumB² / sumA²)
   ```
   Match-the-RMS-norm rather than the Procrustes-optimal
   `s* = trace(R·S) / sumA²`. The two coincide for perfectly
   aligned layouts and diverge as alignment quality drops; the
   ratio `s_procrustes / s_match_rms` is exactly the correlation
   coefficient between `R·a` and `b`.

   Citation-driven and basePos-driven layouts are **partially**
   correlated. Citations come out of the taste network, which biases
   edges toward spatially-close pairs in basePos — so the topologies
   agree about cluster structure. But FR is finding its OWN 3D
   embedding of that topology: it has its own radial t-anchor that
   pulls older nodes inward regardless of where basePos put them,
   and many topologies admit multiple distinct 3D realisations.
   Empirically the correlation coefficient comes out around 0.5.

   Procrustes-optimal would shrink the source proportional to
   alignment quality (half-correlated → half-scale), making citation
   edges much shorter than basePos edges. We don't want that —
   the user is reading the slider as "blend between two
   visualisations of the same network at the same scale", and a
   scale jump at α=1 reads as "the camera zoomed out" rather than
   "the topology rearranged."

   `s = √(sumB² / sumA²)` decouples scale from alignment quality:
   the source's RMS extent always equals the target's, regardless
   of how well rotation aligns them. `R` still does the orientation
   work; `s` just keeps the visual scale comparable.
6. **Apply** to each node in the component:
   ```
   alignedCitationPos[i]  =  s · R · (citationPos[i] − c)  +  bc
   ```

### 2.4 Cost

`O(N + |E|)` for union-find plus the per-component math. Total:
`O(N + |E|)` — runs in microseconds for typical sizes.

---

## 3. Output contract

`Float32Array(n × 3)`. Every value finite. Indexed by data-node id:

```
alignedCitationLayout[i*3]   = x
alignedCitationLayout[i*3+1] = y
alignedCitationLayout[i*3+2] = z
```

Validators in `app/src/citation-layout/contract.js`. The blend force
hook (`app/src/blend/blend.js`) consumes this array verbatim alongside
basePos and lerps each frame.

---

## 4. Failure modes worth knowing about

- **Components overlap** if their basePos centroids happen to
  coincide. Per-component Kabsch can't separate them — it has no
  inter-component repulsion. Visually possibly confusing; correct
  in terms of topology (no edges between them). An inter-component
  spacing pass is left for a later phase.

- **Two-node components** have a degenerate Kabsch (rotation around
  the axis connecting the two points is undefined). The Horn solver
  picks one valid rotation; the choice is arbitrary but consistent
  across runs (same seed → same eigenvector pick).

- **Very sparse graphs** (most nodes isolated) produce an
  alignedCitationPos where most nodes sit at their basePos and the
  few connected components float slightly off — the blend then
  does very little, and the visualisation is roughly basePos at any α.
  This is honest: a graph with no citations has no citation-driven
  topology to render.

- **The outer wall activates** when a self-repelling cloud's natural
  equilibrium exceeds `R · outerWallFraction`. Nodes pile onto the
  wall surface. With `tBias` high enough this never happens for
  realistic graphs; tune higher if you see a peripheral shell where
  none belongs.
