# Network dynamics — math as currently implemented

This document describes the math that is actually running in `network-dynamics.html` today (the version that "mostly works"). It is meant as the reference for the clean rebuild — anything not described here should not appear in the rebuilt version, and anything described here should appear once and only once.

The pipeline has four stages, each with its own math:

1. **Generation** — sampling node positions and timestamps.
2. **Cluster inference** — recovering cluster IDs from positions.
3. **Citation generation** — choosing which directed edges exist.
4. **Layout dynamics** — the spring force that moves nodes each tick.

Section 5 lists the controls and what each one actually drives.

---

## 1. Generation: where nodes come from

Nodes are sampled from a **Gaussian mixture** over a bounding cube of half-extent `R = 60`.

**Inputs.** `pointsOfOrigin` (number of mixture centres, call it `K`), `nodeCount` (total nodes `N`), `seed`.

**Centres.** For each `k ∈ [0, K)`, the centre `μ_k ∈ ℝ³` is sampled with each axis uniform on `[−R, +R]`. (Uniform per axis, i.e. uniform in the bounding cube — *not* uniform in a ball. Every point in the cube is equally likely.)

**Spreads.** Each centre gets an independent per-axis standard deviation:
```
σ_k,axis  =  R · (0.07 + u · 0.18) · spreadScale,     u ~ U(0,1)
```
so at the default `spreadScale = 1` each `σ` lies in `[0.07·R, 0.25·R] = [4.2, 15]`. `spreadScale` is a global multiplier the user can drag live — `>1` widens every blob, `<1` tightens it. Because σ is independent per axis, mixture components are axis-aligned ellipsoids, not spheres.

**Allocation across centres.** Every centre is guaranteed at least one node. The remaining `N − K` nodes are distributed by weighted multinomial draws:
```
w_k  =  0.4 + u_k,         u_k ~ U(0,1),     k = 0..K−1
```
For each remaining node, draw `r ~ U(0, Σw)` and assign it to the first `k` whose cumulative weight exceeds `r`.

**Position.** A node assigned to centre `k` is placed at
```
x_i  =  μ_k  +  g ⊙ σ_k,        g ~ 𝒩(0, I₃)
```
where `g` is a 3-vector of independent standard normals (Box–Muller) and `⊙` is component-wise multiplication. The resulting position is stored as `basePos[i]` and is *frozen* — it never changes after generation.

**Timestamp.** Each node gets `t_i ~ U(0,1)`. Used only by citations: a citation `i → j` requires `t_i > t_j` (newer cites older).

The generator emits only positions and timestamps. **It does not assign cluster IDs.** Cluster IDs come from step 2.

---

## 2. Cluster inference: pluggable algorithms behind a contract

Cluster IDs are recovered from `basePos` by a clustering algorithm that
the user picks at runtime from the **Cluster ▾** dropdown. The toy
keeps every algorithm behind a fixed `ClusterResult` contract so the
rest of the pipeline (citations, neighbourhoods, taste, render) reads
the same fields regardless of which algorithm produced them.

**See `doc/clustering.md`** for:

- §1 the `ClusterResult` contract, validated at runtime by
  `app/src/contracts/cluster.js`
- §2 every consumer of cluster output across the codebase
- §3 the algorithm-registry shape that lets new algorithms register
  themselves with no UI edits
- §4 the algorithms currently registered, with full math:
  - **§4.1 Mutual k-NN** — top-K + mutuality + connected components.
    Conservative about cluster peripheries (the "halo trap"), but
    refuses to chain narrow bridges between dense regions.
  - **§4.2 HDBSCAN** — core distances + mutual-reachability MST +
    condensed-tree EOM extraction with stability scoring. Density-
    aware. Has a noise concept resolved by `noiseMode = absorb |
    singletons`.
- §5 the rerun semantics
- §6 the contract changelog

What's stable across algorithms (and therefore safe to rely on from
elsewhere in `dynamics.md`):

- Every node has a non-negative cluster id; the toy never propagates
  raw `-1` (HDBSCAN's pre-absorption noise stays in `noiseFlags` for
  debug overlays only).
- `clusters[c].centre` is always defined.
- Cluster ids are contiguous from 0.
- Clustering runs against `basePos`, never against the live moving
  positions.

**Reruns** — clustering re-runs on regeneration, when the active
algorithm changes, or when any algorithm-specific param changes. See
`clustering.md` §5 for the cascade.

---

## 3. Citation generation: pluggable algorithms behind a contract

Citations are directed edges `i → j` ("i cites j", subject to
`t_i > t_j`) produced by an algorithm the user can swap at runtime.
Like clustering (§2), the toy keeps every algorithm behind a fixed
`CitationResult` contract so the rest of the pipeline (citation
layout, alignment, render) reads the same fields regardless of which
algorithm produced them.

**See `doc/citations.md`** for:

- §1 the `CitationResult` contract, validated at runtime by
  `app/src/citations/contract.js`
- §2 every consumer of citation output across the codebase
- §3 the algorithm-registry shape that lets new algorithms register
  themselves with no other code edits
- §4 the algorithms currently registered, with full math:
  - **§4.1 Taste Network** — four pure stages (within-cluster
    neighbourhoods → per-neighbourhood taste with distance-decaying
    shared-taste pass → cluster-level triangle transitivity weighted
    by neighbourhood representativeness → per-pair Bernoulli sampling
    with category budgets). Lifted byte-identical from v2's citation
    pipeline.
- §5 the rerun semantics (sub-stage caches in main.js for granular
  re-runs)
- §6 the contract changelog

What's stable across algorithms (and therefore safe to rely on from
elsewhere in `dynamics.md` and from the layout / blend layers):

- `hasCit` is symmetric and indexed `i*n + j`.
- `edges` is a normalised `i < j` pair list — citation-layout
  iterates this directly.
- `inDeg` is the incoming-citation count per node, used for
  colour-by-in-degree rendering only.
- Citations always satisfy `t_source > t_target` (newer cites older);
  layout and alignment ignore direction.
- Algorithm-specific intermediate state (taste sets, neighbourhood
  ids, etc.) is **not** exposed through the contract — those are
  implementation details of whichever algorithm is registered.

**Reruns.** Citations re-run on regeneration, when the active
clustering changes, when any citation-modal param changes, or when
the citation seed is re-rolled. See `citations.md` §5 for the cascade
and main.js's sub-stage caching.

---

## 4. Layout dynamics: deterministic blend between two topologies

Live node positions are not produced by a constraint solver any more.
The user picks where on a continuum between two **precomputed**
arrangements they want to see, and the per-frame work is a single
linear interpolation.

### 4.1 The two endpoints

**`basePos[i]`** — the Gaussian-mixture cloud from §1, frozen at
generation. This is the α=0 layout: every node sits exactly where the
generation seed put it.

**`alignedCitationPos[i]`** — a 3D arrangement derived from the
citation graph alone, then rigidly aligned (per connected component)
to basePos. This is the α=1 layout. See `doc/citation-layout.md`
for the algorithm; the short version is "Fruchterman-Reingold force-
directed layout in 3D, with a radial time-axis bias so older nodes
tend toward the centre, then per-component Kabsch alignment to
basePos."

### 4.2 The blend

Per frame, for every data node `i`:

```
live_i  =  (1 − α) · basePos_i  +  α · alignedCitationPos_i
```

with `α ∈ [0, 1]`. Implemented in `app/src/blend/blend.js` as a
d3-force-3d "force" hook that mutates `node.x/y/z` directly.
`d3VelocityDecay = 1.0` so the lib's `x += vx; vx *= 0` integration
is a no-op alongside our writes.

No state, no momentum, no iteration. The slider drives a deterministic
function of α. Round-tripping `α: 0 → 1 → 0` returns the network to
basePos byte-identical (verified in
`scratch/v3_phase3_smoke.py`: round-trip drift = 0.000).

### 4.3 Why no constraint solver

Every previous version of this app drove layout through a damped
spring system: pairwise constraints + velocity + integration. Three
problems compounded:

- **Momentum stored energy.** Slider nudges injected impulse into
  velocities; the network rang out for seconds afterwards.
- **Per-tick force scaled with N.** At high citation density, every
  node had hundreds of constraints firing per tick. The integrator
  wasn't stable.
- **Distance constraints are rigid-body invariant.** Asymmetric
  impulses imparted angular momentum and the network rotated visibly
  during α sweeps.

For a "show me what the layout looks like at this blend value" demo,
none of that statefulness is doing useful work. v3 deletes the entire
spring/PBD layer and replaces it with a deterministic lerp between
two static endpoints.

### 4.4 Behaviour by α

| α          | Live position                               | Effect                                                              |
|------------|---------------------------------------------|---------------------------------------------------------------------|
| 0          | `basePos`                                   | Pure embedding. Citation graph plays no role in geometry.           |
| 0 → 1      | `(1−α)·basePos + α·alignedCitationPos`      | Smooth interpolation. Each node follows a straight line in 3-space. |
| 1          | `alignedCitationPos`                        | Citation topology drives layout. basePos plays no role in geometry. |

The blend is **linear in position**, not in edge length. An edge whose
two endpoints are far apart in basePos and close in citationPos
spends intermediate α values at intermediate distances — the
interpolation is geometric, not topological. (We considered a
"minimum-stress path" through configuration space; left for v3.1.)

### 4.5 Disabled lib forces

The d3-force-3d library injects defaults; we zero them so nothing
fights the blend hook:

- `charge.strength = 0` — n-body repulsion would push nodes off the
  blend line.
- `link.strength = 0` — the lib's default link spring is a no-op.
  Left registered so the lib's tick scheduler doesn't trip.
- `Graph.d3VelocityDecay(1.0)` — kills any vx/vy/vz that could
  accumulate from drag interactions. The blend hook owns motion.

### 4.6 Recompute lanes

The blend force closure reads three getters every tick:
`getBasePos`, `getAlignedCitationPos`, `getBlend`. So changes to the
underlying buffers take effect on the next frame without
re-registering the hook.

- `state._basePos` — repopulated by `precomputeBasePos()` on every
  regeneration. n × 3 Float32Array.
- `state.alignedCitationLayout` — repopulated by `relayoutCitations()`
  whenever the citation graph or the layout params change. n × 3
  Float32Array.
- `state.blend` — written by the slider's `oninput`. Number in `[0, 1]`.

Slider drag still calls `Graph.d3ReheatSimulation()` because the
lib's tick loop freezes when "the network looks settled" (which is
instant under blending). Without reheat, slider drags after the
freeze go ignored.

---

## 5. Controls — what each one actually changes

| Control                                              | Affects                                | Recompute path                                                        |
|------------------------------------------------------|----------------------------------------|-----------------------------------------------------------------------|
| `seed`, `nodeCount`, `pointsOfOrigin`, `spreadScale` | Generation                             | regenerate → recluster → re-neighbour → re-taste → resample           |
| Cluster ▾ algorithm switch / any clustering-modal slider | Cluster inference (see `clustering.md`) | recluster → re-neighbour → re-taste → resample                       |
| `neighbourK`                                         | Stage 1 (neighbourhoods)               | re-neighbour → re-taste → resample                                    |
| `favouritesMean`, `sharedTaste`, `tasteRange`, `transitiveBoost` | Stages 2 + 3 (taste)                   | re-taste → resample                                                   |
| `tasteSeed`, *Randomize taste*                       | Stages 2 + 3                           | re-taste → resample                                                   |
| `density`, `intraRate`, `crossRate`                  | Stage 4 budget                         | resample → relayout                                                   |
| `epsilonIntra`, `epsilonCross`                       | Stage 4 base rates                     | resample → relayout                                                   |
| `samplingSeed`, *Randomize sampling*                 | Stage 4                                | resample → relayout                                                   |
| Citation Layout ▾ algorithm switch / layout-modal sliders | Citation-layout params (FR knobs)     | relayout (FR + per-component alignment)                              |
| `blend` (slider)                                     | Per-frame interpolation factor only    | reheat (no recompute; blend force re-reads each tick)                |
| `baseDensity` (visual)                               | Visible base edges only                | rebuild graph data (no layout change)                                |
| Freeze                                               | Sim pause                              | `Graph.pauseAnimation/resumeAnimation`                                |
| edge toggles, colours, γ                             | Render only                            | rebuild graph data / refresh                                          |

**Important non-couplings:**
- `baseDensity` is **purely visual**. The blend uses every pair's
  `basePos` regardless of how many base edges are drawn.
- Cluster IDs are **only** used by citation generation as a grouping.
  They have no effect on either layout endpoint.
- Colour-by mode is render-only; it does not change layout or
  topology.

---

## 6. Frozen quantities

Once generation runs, these are immutable until the next regeneration:
- `basePos[i]` for every node
- `t_i` for every node
- `state._basePos` (flat `Float32Array(n×3)` form of basePos, used by
  the blend force and the alignment pass)

Cluster IDs are immutable until the active clustering algorithm or
any of its params change (or regeneration). See `clustering.md` §5.

Neighbourhood IDs are immutable until `neighbourK` changes (or any
upstream change).

`alignedCitationLayout` is immutable until the citation graph or the
citation-layout params change (`relayoutCitations()` re-runs FR and
the per-component Kabsch alignment in one pass).

Per-neighbourhood taste sets `T(Ng)` are immutable until any Stage 2/3 knob changes or `tasteSeed` is rolled (or any upstream change).

Citations are immutable until any Stage 4 knob changes or `samplingSeed` is rolled (or any upstream change).

Live positions `(x_i, y_i, z_i)` and velocities are the only things that change every tick.
