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

## 3. Citation generation: a layered taste model

Citations are directed edges `i → j` meaning "i cites j", subject to `t_i > t_j` (newer cites older). They are produced in **four pure stages** with separate seeds. Modules: `neighbourhoods.js`, `citation-taste.js`, `citations.js`.

**Why this is layered, not the single-pool approach used in v1.** In v1 cross-cluster citations were drawn from one global pool weighted by `1/d⁴`. That meant cross-citation targets were biased toward *spatial neighbours*, not *thematic neighbours*. The model here separates the two: cluster-level "taste" decides *which* clusters get cited; spatial proximity inside a cluster decides *which intra-cluster pair* gets cited.

The three new ideas:

1. **Neighbourhoods.** Inside each cluster, members partition into small mutual-k-NN groups. Within-neighbourhood pairs are likely to cite each other; cross-neighbourhood-same-cluster pairs are not.
2. **Per-neighbourhood taste.** Each neighbourhood picks a small set of "favourite" cross-clusters it tends to cite. Neighbourhoods within the same cluster mostly agree (with drift). Whether the favourite is geometrically close is irrelevant.
3. **Triangle transitivity.** If two clusters both cite a third, they become more likely to cite each other.

### 3.1 Stage 1 — Within-cluster neighbourhoods

Mutual k-NN connected components, but run **per cluster**, restricted to that cluster's members and their basePos coordinates only.

**Input.** Generation result + cluster result + `neighbourK` (default 3).

**Algorithm.**
1. For each cluster `c`, take its member set `M_c`.
2. For each `i ∈ M_c`, find its top-`K` nearest neighbours in `M_c \ {i}` by Euclidean basePos distance.
3. Build the mutual k-NN graph on `M_c` only and find connected components.

Output: `nodeNeighbourhood[i]` for every node, plus per-neighbourhood metadata `{ id, clusterId, members, centroid, count }`. Neighbourhood IDs are unique across the whole dataset.

**Why this captures your two requirements automatically.**
- Sparse cluster (large σ relative to size) → top-K neighbours sit far apart → fewer mutual edges → many small / singleton neighbourhoods → fewer same-neighbourhood pairs → fewer intra-cluster citations.
- Two dense lobes inside one cluster, separated by sparse space → the bridge nodes' top-K are inside their home lobe → no mutual edges across the gap → the lobes stay as separate neighbourhoods → independent taste.

### 3.2 Stage 2 — Neighbourhood taste, with distance-decaying shared-taste pass

For each neighbourhood `Ng` belonging to cluster `c`, draw a small "taste set" `T(Ng) ⊂ clusters \ {c}`.

**Knobs.** `tasteSeed`, `favouritesMean` (default 1.5), `sharedTaste` (default 0.7), `tasteRange` (default `R_GLOBAL · 0.3 ≈ 18` scene units).

**Pass 1 — independent draws.** For each `Ng`:
```
favCount  ~  max(1, round(Poisson(favouritesMean)))
T(Ng)_1   =  sampleWithoutReplacement(otherClusters_for(c), favCount)
```
Cap `favCount` at `numClusters - 1`.

**Pass 2 — distance-decaying shared-taste tilt.** Each neighbourhood `Ng ∈ c` redraws its taste with a prior that gives more weight to taste choices made by *spatially-near* sibling neighbourhoods (in the same cluster). The vote of each sibling `Ng'` is weighted by a Gaussian kernel on the centroid distance:

```
r(Ng, Ng')         =  ‖centroid(Ng) − centroid(Ng')‖           (Euclidean, scene units)
K(Ng, Ng')         =  exp(− r² / (2 · tasteRange²))            (Gaussian kernel)

popularity(Ng, d)  =  Σ_{Ng' ∈ c, Ng' ≠ Ng}  K(Ng, Ng') · 1[d ∈ T(Ng')_1]

P(Ng picks d in pass 2)  ∝  1  +  sharedTaste · popularity(Ng, d)
```

Sample `favCount` entries (same count as pass 1, deterministic) without replacement using these weights.

**Why absolute `tasteRange`, not a fraction of cluster spread.** A sparse cluster has its neighbourhoods spread further apart in scene units. With absolute `tasteRange`, distant neighbourhoods of a sparse cluster get small `K` and behave independently. This bakes in your requirement *"the more sparse a cluster is → less shared taste"*. Using a relative scale (`σ = tasteRange · clusterSpread`) would normalise that effect away.

**Effect.**
- `sharedTaste = 0`  ⇒ pass 2 == pass 1 regardless of geometry (independent neighbourhoods).
- `sharedTaste` large  ⇒ neighbourhoods agree, but only with their close-by siblings.
- `tasteRange` very large compared to cluster scale ⇒ kernel ≈ 1 everywhere, behaviour collapses to the uniform-shared-taste model (every sibling votes equally).
- `tasteRange` very small ⇒ kernel ≈ 0 between distinct neighbourhoods, behaviour collapses back to pass 1 (independent draws).

### 3.3 Stage 3 — Triangle transitivity (mixed cluster + neighbourhood)

Stage 3 scores triangles at the **cluster** level, but applies the swap at the **neighbourhood** level with a weight reflecting how *representative* each neighbourhood is of its cluster. Peripheral neighbourhoods are tilted less than central ones.

**Cluster-level taste.**
```
T_cluster(c)  =  ⋃_{Ng ∈ c}  T(Ng)_2
```

**Triangle scoring.** For each ordered cluster pair `(c, d)`, `c ≠ d`:
```
triangleScore(c, d)  =  #{c'  ≠ c, d  :  d ∈ T_cluster(c')  ∧  c ∈ T_cluster(c')}
```
(Number of third clusters that cite *both* `c` and `d`. High score ⇒ closing this triangle is well-supported.)

**Representativeness weight.** A neighbourhood close to its cluster's centroid is "core" to that cluster's identity; a neighbourhood at the edge is "peripheral." Weight each `Ng ∈ c` by:
```
ρ(Ng)  =  exp(− r(Ng, c)² / (2 · tasteRange²))
       where  r(Ng, c) = ‖centroid(Ng) − centroid(c)‖
```
Same Gaussian kernel and same `tasteRange` as stage 2 — peripheral neighbourhoods (those further from the cluster centroid) attenuate, central neighbourhoods get full weight.

**Pass 3 — triangle swap.** For each `Ng ∈ c`, sample a candidate target `d` proportional to:
```
weight(d)  ∝  triangleScore(c, d)        for d ∉ T(Ng)_2 ∪ {c}
weight(d)  =  0                          otherwise
```
Then with probability `transitiveBoost · ρ(Ng) · normaliser`, swap one entry of `T(Ng)_2` with `d`. (The normaliser caps acceptance at 1 even if the score is large.)

**At most one swap per neighbourhood per pass.** The pass runs once over the whole dataset, in deterministic order, with `tasteSeed`.

**Knobs.** `transitiveBoost` (default 0.4). `0` ⇒ pass is a no-op. The kernel range is shared with stage 2 (`tasteRange`) — there's no separate knob.

The output of stage 3 is the final taste set `T(Ng)` for every neighbourhood. From here on, taste is fixed.

### 3.4 Stage 4 — Pair sampling

Now we draw the actual citation edges. For every ordered pair `(i, j)` with `t_i > t_j` we compute a per-pair rate, then sample.

**Knobs.** `samplingSeed`, `density d`, `intraRate r_in`, `crossRate r_cr`, `epsilonIntra ε_in` (default 0.05), `epsilonCross ε_cr` (default 0.01).

**Per-pair base rate.**

Let `c_i = cluster(i)`, `c_j = cluster(j)`, `Ng_i = neighbourhood(i)`, `Ng_j = neighbourhood(j)`.

```
intra-cluster (c_i == c_j):
   if Ng_i == Ng_j:           rate(i, j)  =  1                  (full intra rate)
   else:                      rate(i, j)  =  ε_in               (soft cross-neighbourhood)

cross-cluster (c_i ≠ c_j):
   if c_j ∈ T(Ng_i):          rate(i, j)  =  1                  (taste-matched)
   else:                      rate(i, j)  =  ε_cr               (soft off-taste)
```

The `1/d⁴` distance weight from v1 is **gone**. Cross-cluster targeting is uniform across the target cluster's members — which member you pick is a coin flip; *which cluster* you target is what taste decides. Intra spatial proximity is handled by neighbourhood membership rather than a continuous distance weight.

**Budget enforcement.** Sum the rates per category and scale to hit the user's targets:

```
sum_intra  =  Σ_{intra pairs}    rate(i, j)
sum_cross  =  Σ_{cross pairs}    rate(i, j)

fracIntra  =  min(1, d · r_in)
fracCross  =  min(1, d · r_cr)

target_intra  =  fracIntra · #{valid intra pairs}
target_cross  =  fracCross · #{valid cross pairs}

scale_intra   =  target_intra / sum_intra        (clamped to [0, 1])
scale_cross   =  target_cross / sum_cross        (clamped to [0, 1])
```

**Sampling.** For every valid pair, include it with probability `rate(i, j) · scale_category`. Single Bernoulli draw per pair; `mulberry32(samplingSeed)` is the only source of randomness here. No rejection sampling, no "pick exactly N" — that would re-introduce coupling between pairs. The expected count matches the user's budget; the variance is small at large pool sizes.

**Saturation.** `r_in = 1, d = 1, ε_in = 0` ⇒ every same-neighbourhood intra pair is cited; cross-neighbourhood-same-cluster pairs are skipped.

### 3.5 Re-run rules

Each stage is its own pure function with its own seed; runs of any stage invalidate downstream stages but not upstream ones.

| User action | Rerun |
|---|---|
| `nodeCount`, `pointsOfOrigin`, `spreadScale`, `seed` | generation → clustering → neighbourhoods → taste → sampling |
| any clustering modal change (algorithm or its params) | clustering → neighbourhoods → taste → sampling |
| `neighbourK` | neighbourhoods → taste → sampling |
| `favouritesMean`, `sharedTaste`, `transitiveBoost`, `tasteSeed`, *Randomize taste* | taste → sampling |
| `density`, `intraRate`, `crossRate`, `ε_intra`, `ε_cross`, `samplingSeed`, *Randomize sampling* | sampling only |

### 3.6 Outputs and derived caches

The pair-sampling stage emits:
- `citations: [{source, target}]` — directed edge list.
- `hasCit[i,j]` — symmetric `n×n` `Uint8Array`, used by the spring force in §4.
- `inDeg[j]` — `Int32Array`, used only for colouring.
- `pools: { intraValid, crossValid, intraPicked, crossPicked }` — read-only diagnostics for the modal status line.

The taste stage emits:
- `tasteByNeighbourhood[Ng] : Set<clusterId>` — the final `T(Ng)` after stage 3.
- `tasteByCluster[c] : Set<clusterId>` — union over all `Ng ∈ c`. Used by debug overlays (cluster-taste arrows).

---

## 4. Layout dynamics: the hybrid spring force

This is the only force acting on nodes. It runs every physics tick.

**Pairwise spring, every pair.** For every unordered pair `(i, j)` with `i < j`, compute a rest length `ℓ_ij` and a strength multiplier `s_ij`:

```
semRest_ij  =  ‖basePos_i − basePos_j‖              (frozen at generation)

if pair is cited (hasCit[i,j] == 1):
    ℓ_ij  =  max(0, (1 − α) · semRest_ij)
    s_ij  =  max(1, α)
else:
    ℓ_ij  =  semRest_ij
    s_ij  =  1
```

Then apply the spring update to live positions `(x_i, y_i, z_i)`:
```
Δ          =  x_j − x_i        (vector)
d          =  ‖Δ‖   (floored at 1e-6)
k          =  STRENGTH · s_ij · simAlpha · (d − ℓ_ij) / d
v_i  +=  k · Δ
v_j  −=  k · Δ
```
with `STRENGTH = 0.04`. `simAlpha` is d3-force-3d's own decaying simulation alpha (the cooling schedule), not the user-facing α.

After all pairs are processed in a tick, d3-force-3d applies its standard velocity decay (`d3VelocityDecay = 0.55`) and integrates positions.

**Behaviour by region of α:**

| α        | Cited pair rest | Cited pair strength | Effect                                                          |
|----------|-----------------|---------------------|-----------------------------------------------------------------|
| 0        | `semRest`       | 1                   | Every pair pulls to its semantic rest length. Layout = embedding.|
| 0 → 1    | `(1−α)·semRest` | 1                   | Cited pairs linearly contract. Uncited pairs unchanged.         |
| 1        | 0               | 1                   | Cited pairs rest length = 0 (want to overlap).                  |
| α > 1    | 0 (clamped)     | α                   | Cited pairs still want to overlap, *and* pull harder.           |

**Why the clamp at α > 1.** Without clamping, `ℓ_ij` would go negative for cited pairs. The spring force `k = STRENGTH·(d − ℓ)/d` is then unbounded as `d → 0` (large negative `ℓ`, tiny `d`, ratio explodes), which produces visible oscillation/shake on cited pairs. Clamping `ℓ` at 0 and routing the "extra pull" through `s_ij = α` instead gives a bounded force that scales monotonically with α.

**The cascade.** Uncited nodes still move when their neighbours move, because every pair has a base spring at `semRest`, regardless of citation. Force propagates through the network of base springs; α never touches the uncited springs directly.

**Other forces are explicitly disabled:**
- `charge.strength = 0` — no n-body repulsion. (Repulsion fights the cited-pair contraction at high α and produces oscillation.)
- `link.strength = 0` — the library's default link spring is a no-op. (The hybrid force above replaces it; the link force is left registered so the library's tick scheduler doesn't trip.)
- Cooldown: `cooldownTicks = Infinity`. The simulation runs forever; pause is via the Freeze button (`Graph.pauseAnimation()`).

**Equilibrium intuition.** With α = 0, every pair has rest length equal to its original embedding distance, so the system is at equilibrium at the embedding. Turn α up: cited pairs want to be closer than the embedding suggests; uncited pairs still want their original distance. The system settles into a compromise where citation-dense regions contract and the rest of the embedding deforms around them. At α ≫ 1, cited subgraphs collapse to near-points.

---

## 5. Controls — what each one actually changes

| Control                                              | Affects                                | Recompute path                                                        |
|------------------------------------------------------|----------------------------------------|-----------------------------------------------------------------------|
| `seed`, `nodeCount`, `pointsOfOrigin`, `spreadScale` | Generation                             | regenerate → recluster → re-neighbour → re-taste → resample           |
| Cluster ▾ algorithm switch / any clustering-modal slider | Cluster inference (see `clustering.md`) | recluster → re-neighbour → re-taste → resample                       |
| `neighbourK`                                         | Stage 1 (neighbourhoods)               | re-neighbour → re-taste → resample                                    |
| `favouritesMean`, `sharedTaste`, `tasteRange`, `transitiveBoost` | Stages 2 + 3 (taste)                   | re-taste → resample                                                   |
| `tasteSeed`, *Randomize taste*                       | Stages 2 + 3                           | re-taste → resample                                                   |
| `density`, `intraRate`, `crossRate`                  | Stage 4 budget                         | resample                                                              |
| `epsilonIntra`, `epsilonCross`                       | Stage 4 base rates                     | resample                                                              |
| `samplingSeed`, *Randomize sampling*                 | Stage 4                                | resample                                                              |
| `α` (alpha, future)                                  | Force parameters                       | reheat (no regen, no resample)                                        |
| `baseDensity` (visual)                               | Visible base edges only                | rebuild graph data (no physics change)                                |
| Freeze                                               | Sim pause                              | `Graph.pauseAnimation/resumeAnimation`                                |
| edge toggles, colours, γ                             | Render only                            | rebuild graph data / refresh                                          |

**Important non-couplings** (these used to be coupled and are now separated):
- `baseDensity` is **purely visual**. The physics uses every pair's `basePos` distance regardless of how many base edges are drawn.
- Cluster IDs are **only** used by citation generation as a grouping. They have no effect on the spring force.
- Colour-by mode is render-only; it does not change physics or topology.

---

## 6. Frozen quantities

Once generation runs, these are immutable until the next regeneration:
- `basePos[i]` for every node
- `t_i` for every node
- `_baseDist[i,j]` (precomputed `‖basePos_i − basePos_j‖`)

Cluster IDs are immutable until the active clustering algorithm or any of its params change (or regeneration). See `clustering.md` §5.

Neighbourhood IDs are immutable until `neighbourK` changes (or any upstream change).

Per-neighbourhood taste sets `T(Ng)` are immutable until any Stage 2/3 knob changes or `tasteSeed` is rolled (or any upstream change).

Citations are immutable until any Stage 4 knob changes or `samplingSeed` is rolled (or any upstream change).

Live positions `(x_i, y_i, z_i)` and velocities are the only things that change every tick.
