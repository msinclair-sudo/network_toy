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
citation-layout/{fr|mds}.js  →  citationPos    (algorithm of choice)
    │
    ▼
blend/align.js               →  alignedCitationPos
                                 (per-component similarity
                                  alignment to basePos)
```

The layout module exposes a registry; today there are two
algorithms with different flavours:

| id                       | flavour     | what it preserves                                    |
|--------------------------|-------------|------------------------------------------------------|
| `fruchterman-reingold`   | cladogram   | topology only; edge LENGTHS are arbitrary force balance |
| `mds-graph-distance`     | dendrogram  | per-pair distance ≈ graph-shortest-path distance     |

User picks via the **Citation Layout ▾** menu. Phase 7 added MDS;
the registry pattern means future additions (spectral, hierarchical
tree-by-`t`, etc.) plug in the same way.

---

## 1. Layout: Fruchterman–Reingold in 3D (cladogram)

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

## 2. Layout: MDS on graph distance (dendrogram)

`app/src/citation-layout/mds.js`. Multidimensional scaling, where
the target distance for every pair is the **graph-shortest-path
distance** times a scale factor:

```
target_ij  =  scaleD · d_ij
```

Per-component: each connected component is its own MDS problem.
Cross-component pairs are deliberately omitted from the stress
function (no path → no graph distance to preserve). Singletons
land at origin and are then translated to basePos by the alignment
step.

### 2.1 Why MDS

FR is *cladogram-flavoured* — it tells you which nodes are
connected, but edge LENGTHS are arbitrary force balance. A 1–2–3
chain ends up with `|x_1 − x_3|` set by repulsion vs. attraction in
the 1↔3 pair (which has no edge between them in FR's view), not by
the fact that 1 and 3 are graph distance 2 apart.

MDS is *dendrogram-flavoured* — pairwise 3D distances reflect
pairwise graph distances. The 1–2–3 chain falls out collinear with
`|x_1 − x_3| = 2 · |x_1 − x_2|`, exactly because `d(1, 3) = 2`.
Verified: `scratch/v3_phase7_acceptance.mjs` chain test gets
ratio 1.995.

For larger graphs, exact ratio preservation is bounded by the
intrinsic dimensionality of the graph relative to 3D (Phase 7
acceptance: ratio for `d=2` pairs / `d=1` pairs is 1.68 on the
seed=42 dense graph, instead of the chain test's 1.995 — graphs
with high effective dimension can't be embedded in 3D without
distortion).

### 2.2 SMACOF Guttman update

Stress:
```
σ  =  Σ_pairs ( |x_i − x_j|  −  scaleD · d_ij )²
```

Each iteration applies the Guttman transform — for every node `i`,
replace `x_i` with the centroid of "ideal positions for i" derived
from each pair:

```
new_x_i  =  (1 / (m−1))  ·  Σ_{j≠i}  [ x_j  +  (t_ij / |x_i−x_j|) · (x_i − x_j) ]
```

This is the standard SMACOF update; monotonically decreases stress
on a quadratic majorant; no learning rate or temperature needed.
Degree-normalised by construction (the `1/(m−1)` factor) so dense
components don't blow up like a naïve gradient-descent would.

For coincident pairs (`|x_i − x_j| = 0`), the limit of
`(t_ij / |x_i−x_j|) · (x_i − x_j)` is 0, so the contribution is just
`x_j`. Implemented as a special-case branch.

Atomic Jacobi-style update: read all `x` from the previous
iteration, compute all new `x`, then swap. No iteration-order bias.

### 2.3 Cost

`O(iterations · n²)` for the inner loop; `O(N · (N + |E|))` for the
BFS that builds the graph-distance matrix once per recompute. For
`n = 184, iterations = 200` that's around 7 M JS ops, runs in ~60
ms. Same recompute trigger as FR.

### 2.4 Initial positions + seeding

Random in a cube of half-extent `scaleD/2`, seeded from the citation
seed XOR'd with a marker constant. Deterministic for a given
`(n, edges, t, seed, params)` tuple.

`t` is accepted in the input contract for symmetry with FR but
ignored — MDS doesn't have a time-bias mechanism (graph distance
is the only structure it preserves). If you want time stratification
of the layout, use FR.

---

## 3. Alignment to basePos

The layout produced by either §1 or §2 sits in its own coordinate
frame (orientation, centroid, and scale picked by the algorithm's
internal force / stress balance, not by anything basePos says). The
alignment step that brings it into basePos's frame — per-component
similarity transform with match-RMS scaling — lives in the **blend**
layer, not the layout layer, by encapsulation: the layout module
never sees basePos.

**See `doc/blend.md` §1** for the alignment math: union-find on the
citation graph, per-component Kabsch via Horn's quaternion, the
match-RMS scale formula and why it's preferred over the textbook
Procrustes-optimal scale (which collapses partially-correlated
sources toward the target centroid), and the alignment correlation
coefficient that falls out for free as a quality metric.

`alignByComponent({ basePos, citationPos, edges, n })` returns
`{ aligned, correlation }`. main.js caches both on
`state.alignedCitationLayout` and `state.alignmentCorrelation`.

---

## 4. Output contract

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

## 5. Failure modes worth knowing about

These are layout-side failure modes. Alignment-side failure modes
(component overlap, two-node degeneracy, coincident-points) are
documented in `doc/blend.md` §1.7.

- **Very sparse graphs** (most nodes isolated) produce a layout
  where most nodes sit near origin and the few connected components
  float slightly off. After alignment they end up at their basePos
  positions; the blend then does very little and the visualisation
  is roughly basePos at any α. This is honest: a graph with no
  citations has no citation-driven topology to render.

- **The FR outer wall activates** when a self-repelling cloud's
  natural equilibrium exceeds `R · outerWallFraction` (default
  `1.5 · R`). Nodes pile onto the wall surface. With `tBias` high
  enough this never happens for realistic graphs; tune higher if
  you see a peripheral shell where none belongs. MDS doesn't have a
  wall — it's bounded by graph diameter directly.

- **MDS in 3D can't always satisfy every graph-distance target**
  for graphs whose effective dimension is greater than 3 (which is
  most non-trivial citation networks). Stress doesn't go to zero;
  the layout is the best 3D projection. Empirically:
  `dist=2 / dist=1` ratio comes out below 2.0 (~1.7 in our test
  graph) instead of exactly 2.0. The chain test in
  `scratch/v3_phase7_acceptance.mjs` gets 1.99 because a 3-node
  path IS embeddable in 1D.
