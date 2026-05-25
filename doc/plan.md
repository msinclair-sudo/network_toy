# Plan — converging the toy and the real pipeline

**Status:** in-flight. Decisions below are committed; the
sequencing in §6 has been substantially revised to reflect what's
actually been built. Pairs with `doc/clustering-research.md` for
the research that justifies the picks.

**Current state (2026-05-24):** the toy has been substantially
re-shelled with a new UI architecture (workflow chart + multi-tab
panels + modal infrastructure) that wasn't itemised in the
original plan but turned out to be the prerequisite for almost
everything else. Multi-level clustering with global / within-parent
scope is live. Mode-aware "node table" legend follows whatever's
colouring the 3D viewer. Selection is generalised across cluster /
origin / node types. `connected-components` is the first new
algorithm registered. Validate + Optimise (cluster modal tabs) are
**beta** — interface and scorer set will change. The Optimise tab
has since grown a **target-range** sweep mode (§6.17) that hunts
for stable params producing a user-specified cluster-count band,
much cheaper than full grid at real-data scale.

Layer 1.5 has since grown to **five stages** (noise → fusion →
compression → viz / viz2d) with `graph-diffusion` registered as
the fusion-slot algorithm (APPNP-style anchored diffusion). When
fusion is non-identity, `redimred` + `recluster` produce parallel
pre-fusion outputs so a fusion-comparison slider can interpolate
between the two layouts (Procrustes-aligned via the new
`alignGlobal` so the lerp walks the short geometric path). Citation
layout is now opt-in — the cascade stops at Layer 3 and the user
applies a layout algorithm explicitly. `umap-graph` is a third
citation-layout algorithm specifically for sparse n ≥ 1000.

**Recently landed (2026-05-19 → 2026-05-20):**
- **Citation-aware embedding fusion** (§6.15) — new Layer 1.5
  sub-stage. `dimred/graph-diffusion.js` implements anchored
  diffusion `X' = (1−α)X + α·D⁻¹A·X'`. Reads symmetrised citation
  adjacency out of `state.rawCitationEdges` (populated by
  `produceReal()` at ingest from `citation_edges.json`).
- **Fusion-comparison slider + colour mode** — pre-fusion basePos
  + pre-fusion cluster levels stored alongside the post-fusion
  versions. Second slider in the left rail (auto-hides when
  fusion=identity). New `clusterPre:N` colour-mode in
  `viewer-shared/colour-modes.js` to A/B-compare cluster
  assignments across the fusion boundary.
- **alignGlobal** in `blend/align.js` — whole-graph Procrustes
  variant of `alignByComponent` used for preFusion → postFusion
  alignment.
- **Citation layout opt-in** (§6.16) — `markCitationLayoutStale()`
  in the engine; `relayoutCitations()` only runs from the
  Citation Layout modal's Apply path now. Subsumes the layout-
  cache optimisation deferred under §6.15.
- **UMAP-on-citation-graph** (§6.14 partial) — third entry in
  the citation-layout registry. Symmetrised citation adjacency
  → BFS-layer-padded precomputed k-NN → umap-js. Best at sparse
  n ≥ 1000 where FR collapses to a sphere and MDS produces
  orbital shells.
- **Year propagation through real data** — both carver scripts
  now also emit `paper_years.json` (joining
  `citgraphv2/output/nodes.csv` on paper_id). `real.js`
  normalises to `t ∈ [0, 1]` per subset year range, fixing FR's
  identical-pull-on-all degeneration at t=0 everywhere.
- **BFS-5000 carve** — `make_dev_subset_bfs.py` carves a
  connectivity-aware 5000-paper subset (~12 k edges, 100% node
  coverage, 1954–2026 year range). Now the default `real`-mode
  dataset.
- **Earlier in May:** bridge analysis (multi-scale boundary
  detection between any two cluster levels, with per-coarser-
  level share breakdowns surfacing in the bridge / boundary-
  score node-table sources). Layer 1.5 dim-reduction shell —
  registry + contract + originally-four-stage engine lane, modal
  with stacked sections, family-tagged algorithms. `identity`
  (any slot), `pca` (noise), `umap` (compression + viz)
  shipping via umap-js loaded over the importmap. Layer 1 data-
  source registry with `toy` and `real` entries; source
  selection lives in a **Data card → modal** opened from the
  workflow chart. Reingest is mode-agnostic. Real-data ingest
  path lazy-renders — viewer stays empty until the user picks a
  3-d viz reduction.

**UX polish (recent commits):**
- Slot-aware defaults via `defaultParamsForSlot(slot)` on registry
  entries: PCA in noise → `n_components=100`; UMAP in compression
  → `50/50/0.0`; UMAP in viz → `3/15/0.1`. Picking an algorithm
  drops the user at the locked-default config rather than at
  unhelpful generic numbers.
- `Running…` progress indicator + CSS sweep animation on Apply
  buttons in the data + dim-reduction modals; modals stay open
  through the async cascade (real source fetch + reingest +
  redimred + recluster) and close only on completion.
- Plain-language hints throughout the modal schemas — "Output
  dimensions", "Neighbours per point", "Cluster tightness" with
  per-field "Recommended: X for compression, Y for viz" guidance.
- Viz output normalised to a canonical viewer scale
  (`VIEWER_TARGET_RMS=90` in `engine.js`) so UMAP-3 (~`[-3, 3]`
  range) renders at the same volume as the toy's basePos
  (~`[-60, 60]`). Pure isotropic centre + scale; topology
  preserved.

**Optimisation + validation:** Cluster modal pivoted to a tabbed
surface — Configure / Optimise / Validate. Bootstrap-Jaccard
engine (`eval/bootstrap.js`), four pluggable scorers
(`eval/scorers.js`: ARI vs origins, Hennig fraction-stable,
cluster count, and **cluster richness = count × meanJaccard**),
cross-algorithm sweep (`eval/sweep.js`) with a `resolutionOnly`
filter that pins non-resolution params to defaults. Per-row
Apply in Optimise commits a config and hops to Validate to close
the loop. Auto-pick: ARI for toy (ground truth), richness for
real (replaces stability — see "Stability failure mode" below).
The Optimise results table shows **every** swept config (not a
top-N), with **sortable columns** so the user can re-rank by any
visible metric.

**Save / load:** Topbar `File ▾` menu (Save / Save as… / Load…)
writes / reads a `.zip` archive containing manifest + state.json
+ binary TypedArray payloads. Schema-version strict refusal on
load. Includes Validate + Optimise results (now backed by
`state.evalResults`). Engine cascade skipped on load — restored
state is taken as-is.

**2D viewer (just landed):** New canvas-based viewer panel
mounts alongside the 3D viewer, reads `state._basePos2d`
populated by a new Layer 1.5 sibling sub-stage `viz2d`. Both
viewers share `viewer-shared/colour-modes.js` so every colour
mode + selection dim works identically. Also caught a panel-
system recursion bug (mount-time state writes were re-entering
`renderActivePanel`; fixed by pre-registering the tab id).
SCHEMA_VERSION bumped 1 → 2; older saves refuse to load.

**Not yet started:** PaCMAP (deferred — no widely-shipped JS
port; real-pipeline-only candidate), real-pipeline Python port
(Layer 4/5a in scoring app), method manual, IndexedDB autosave
(file save/load shipped; auto-restore-last-session is a follow-
up), Web Worker port for heavy compute lanes (UMAP / HDBSCAN /
FR / UMAP-on-graph), Pivot MDS + spectral citation-layout
algorithms (§6.14 follow-ups beyond UMAP-on-graph).

**Stability failure mode (resolved):** the original stability
scorer ranked trivially-coarse clusterings highest — a single
mega-cluster bootstraps to ~100% stable but conveys nothing.
Resolution: added `numClustersScorer` (raw count) and
`clusterRichnessScorer` (count × meanJaccard, balanced against
both extremes). Auto-pick for real data shifted from stability
→ richness. Stability remains available as an explicit choice
with a docstring warning.

The vision: **one method, two surfaces.** The toy (`app/`) stays
as the low-dim interactive sandbox where researchers explore the
*concepts* via 3-d visualisation. The real-data path
(`literture-network/`) is the high-dim batch tool where the
*work* happens at 810 k papers. They share modules — same
contracts, same registries, same blend math, same alignment
metric — and the docs add up to a manual for the method.

```
                shared layer modules + contracts + registries
                                  │
          ┌───────────────────────┴───────────────────────┐
          │                                                │
   ┌──────▼───────┐                                ┌──────▼─────────┐
   │   toy app    │                                │  real pipeline │
   │              │                                │                │
   │ n ≈ 400      │                                │ n = 810 k      │
   │ 3-d, live    │                                │ 768-d, batch   │
   │ teaches the  │                                │ does the work  │
   │ method       │                                │                │
   └──────────────┘                                └────────────────┘
```

---

## 1. Out of scope (explicit, so we don't drift)

- **Scoring-app integration.** The Shiny scoring app stays
  separate. Eventual simplification is acknowledged but not part
  of this convergence work.
- **3-d visualisation of real data at full scale.** The real
  pipeline visualises in 2-d (UMAP scattergl). The toy visualises
  in 3-d. Subsampling 810 k → ~10 k for the toy's interactive
  surface is a future deliverable (large-data compression).
- **Custom embedding models.** SPECTER2 is the established choice.
- **Citation-discovery rewrite.** `citgraphv2` works.

---

## 2. Architectural changes

### 2.1 New stage: dim-reduction (Layer 1.5) — **shipped, extended in §6.15**

A pluggable dim-reduction stage between Layer 1 (data source) and
Layer 2 (clustering), same registry pattern as every other layer.

**Five stages** (one sequential pair followed by sibling fork):

```
embedding ─▶ noise ─▶ fusion ─┬─▶ compression ──▶ dimredResult (clustering input, e.g. UMAP-50)
                              │
                              ├─▶ viz         ──▶ _basePos     (3D viewer / blend, UMAP-3)
                              │
                              └─▶ viz2d       ──▶ _basePos2d   (2D viewer, UMAP-2)
```

Compression, viz, and viz2d all read the fusion stage's output
(which itself reads noise's output) — so PCA's denoising AND
graph-diffusion's citation-aware re-embedding benefit all three.
The three downstream stages otherwise run independent UMAP fits
with independent params + seeds. Topology computed in topology
space; viewers render by attaching node metadata, so re-running
any of the viz stages never moves cluster IDs and re-running
clustering never moves dots.

Fusion stage history: shipped as a fourth sub-stage in §6.15; it
sits between noise and the sibling triple as a *lateral* stage
(input dimension = output dimension). When `fusion = identity`
(toy default, real-data initial default) it's a no-op; the engine
behaves as the original four-stage design. When `fusion =
graph-diffusion`, the engine ALSO runs compression + viz on the
pre-fusion (noise-stage) output and stores parallel
`dimredResultPreFusion` + `_basePosPreFusion` for the fusion-
comparison slider.

state shape:
```js
state.layerParams.dimred = {
  noise:       { method, params },
  fusion:      { method, params },     // §6.15 addition; identity by default
  compression: { method, params },
  viz:         { method, params },     // 3D viewer / blend
  viz2d:       { method, params },     // 2D viewer
};
```

Each registry entry declares which slots it's eligible for via a
`family` array (`"noise"` | `"compression"` | `"viz"` | `"viz2d"`
| `"any"`). `"any"` covers identity — usable in any slot, acts as
"skip this stage". The dim-reduction modal renders one section per
slot and filters dropdowns by family.

```
app/src/dimred/
  registry.js                registry + slot-aware listAlgorithms(slot)
  contract.js                output: Float32Array(n × d), validated per stage
  identity.js                no-op pass-through (skip-this-stage option)
  pca.js                     PCA (noise; denoiser prefix before UMAP)
  umap.js                    UMAP (compression + viz + viz2d; via umap-js / esm.sh)
  graph-diffusion.js         APPNP-style anchored citation fusion (fusion slot only)
```

Each entry: `{ id, label, family, description, defaultParams, compute,
modalSchema }`. Algorithm signature is `compute(input, params) →
DimredResult` where `input = {n, d, data: Float32Array(n*d)}`.

**Lazy-render gate (real-data UX):** the viewer panel renders only
when `state._basePos` is non-null. The viz sub-stage produces a
`_basePos` only when its output is 3-d. Identity on a 768-d
embedding stays 768-d, which can't render — so the viewer shows
an empty-state hint until the user explicitly picks UMAP-3 (or
PCA-3, or any future 3-d-capable algorithm) in the viz slot. No
special gating logic; it falls out of the contract.

The toy maintains **two independent dim-reduction outputs**:

- **Clustering reduction** (noise → compression — default `umap`
  to 50-d at real-data scale). What Layer 2 consumes via
  `state.dimredResult`.
- **Visualisation reduction** (`viz` sub-stage, default identity at
  toy scale where the data source already supplied basePos; UMAP-3
  for real data). What the viewer + blend consume via
  `state._basePos`. **Never used for clustering.**

Real pipeline only needs the clustering reduction (it visualises
via UMAP-2d in the scoring app, separately).

**Slot-aware defaults.** Each registry entry can declare
`defaultParamsForSlot(slot)`. The dim-reduction modal calls it
when the user picks an algorithm so they land at the locked
config for that slot, not at generic-toy values: PCA in noise →
`n_components=100`; UMAP in compression → `50/50/0.0`; UMAP in
viz → `3/15/0.1`. `defaultParams()` stays as the slot-agnostic
fallback.

**Viz output normalisation.** Engine `redimred()` normalises any
viz-stage output it adopts as `_basePos` to a canonical viewer
scale (`VIEWER_TARGET_RMS=90` in `engine.js` — centre on origin,
isotropic scale so RMS distance from centre is 90 world units).
UMAP outputs in ~`[-3, 3]`; toy basePos lives in ~`[-60, 60]`.
Without normalisation, real data renders as a tiny clump. The
transform is pure isotropic centre + scale, so topology is
preserved exactly. Toy and identity-passthrough basePos are not
normalised — they keep their native scale.

### 2.2 Multi-level clustering (replaces the planned hierarchical contract extension)

**Done — but not the way originally planned.** The original idea
was to extend `ClusterResult` with optional `nodePath` /
`clusterTree` fields. Instead we kept the contract flat and
added a sibling slot:

```js
state.clusterLevels = [
  { uid, scope: "global" | "within-parent", clusterResult: ClusterResult },
  ...
];
state.clusterResult = clusterLevels[finest].clusterResult;   // backward-compat alias
```

Each level is an ordinary `ClusterResult` — the contract didn't
change, every existing panel kept working, and "what level am I
looking at?" is just an array index.

The `scope` flag per level decides whether the algorithm runs
globally (re-cluster the whole dataset at finer resolution) or
within each parent cluster's members. The first level is always
global; subsequent levels can mix freely.

Same algorithm across all levels (single dropdown in the modal).
Per-level algorithm choice (originally planned) was deferred — the
single-algorithm story is cleaner for the user-facing narrative and
nothing has yet pushed back on it.

### 2.3 Two α parameters (real + toy)

Two distinct α's, both surfaced in the integrated tool:

- **Real-pipeline α** (`FUSION_ALPHA`): hybrid graph
  *construction* parameter. `weight = α · cosine_sim + (1−α) ·
  default`. Currently fixed at 0.5; rebuilding requires full
  pipeline re-run.
- **Toy α** (`state.blend`): per-frame *display* parameter. Lerps
  between two precomputed positions. O(n) per frame.

These are orthogonal — real-pipeline α changes *what the data is*;
toy α changes *how it's drawn*. Both can have their own slider.

The toy's α blends two endpoints in the integrated tool:

- α = 0: **viz-umap-3d** (UMAP-on-SPECTER2 to 3-d) — what the
  embedding alone says.
- α = 1: **citation-graph layout** (pivot MDS or sparse spectral,
  per Leiden component) — what the citation topology alone says.

### 2.4 Sparse storage

Already covered in `doc/scaling.md` §3.1. Headline: replace
`Uint8Array(n²)` with sparse `has(i, j) → boolean` query. Real
pipeline already uses CSR for the hybrid graph — that's the
target representation.

### 2.5 Sweep tooling: ARI dim-sweep validation

Existing `app/src/eval/sweep.js` does parameter sweeps. We add a
**dim-sweep**: run the same clustering config at UMAP-target-dim
∈ {30, 50, 100, 200} and compute ARI between resulting partitions.
Threshold: `ARI(50, 100) > 0.9` confirms 50-d isn't costing
accuracy on this corpus.

This is the empirical "no information lost" check. Above the
threshold, the 50-d default is defensible. Below, bump to 100-d.

Other sweeps still apply:

- **Cluster sweep** — shipped as `eval/sweep.js` (§6.5). Ranks
  `algorithms × modalSchema sweep grids` by a single pluggable
  scorer's primary metric (ARI / stability / numClusters / richness),
  not a composite — the four scorers are independent picks rather
  than weighted summands. Composite scoring was reconsidered and
  rejected: separate scorers gave researchers clearer "I chose
  this *because*" rationale than a fused number.
- **Layout sweep** ranks by `alignmentCorrelation` (already done).
- **Cluster-vs-cluster ARI** (Leiden vs HDBSCAN on same data) =
  per-paper disagreement signal, the cheap stability metric.

---

## 3. What we're building (registry contents)

### 3.0 Data-source registry (Layer 1)

| ID | Source | Output shape | Status |
|----|--------|--------------|--------|
| `toy` | Gaussian-mixture generator (wraps `generation.js`) | nodes (with per-node `basePos` + `originId`) + origins. No embedding. | ✓ shipped |
| `real` | SPECTER2 dev subset loader (fetches `literture-network/artifacts/dev_subset/`) | nodes (with `paperId`) + 768-d `embedding`. No basePos — viz sub-stage produces it. | ✓ shipped (1000-paper subset only; carve more via `make_dev_subset.py`) |

```
app/src/datasource/
  registry.js                getDataSource / listDataSources
  contract.js                {nodes, origins?, embedding?, basePos?} validator
  toy.js                     wraps generation.js with UI-friendly param names
  real.js                    fetches .npy + paper-index, parses NPY in-browser
```

Each entry: `{ id, label, description, defaultParams, produce(params)
→ DataSourceResult, modalSchema }`. `produce` may be async — the
real source `fetch`es over the network. The data panel switcher
calls `engine.reingest()` which dispatches through this registry,
wipes every downstream artifact (toy and real are mutually
exclusive), and cascades into the dim-reduction → clustering chain.

### 3.1 Dim-reduction registry

Each entry can declare a slot-aware `defaultParamsForSlot(slot)`
that the modal prefers when the user picks an algorithm; the
table's "Default params" column shows that slot-specific value
where it differs.

| ID | Algorithm | Family | Default params per slot | Status |
|----|-----------|--------|-------------------------|--------|
| `identity` | no-op | `["any"]` | — | ✓ shipped |
| `pca` | PCA | `["noise"]` | noise: `n_components=100` | ✓ shipped |
| `umap` | UMAP | `["compression", "viz", "viz2d"]` | compression: `n_components=50, n_neighbors=50, min_dist=0.0, metric='cosine', random_state=42`<br>viz: `n_components=3, n_neighbors=15, min_dist=0.1, metric='cosine', random_state=43`<br>viz2d: `n_components=2, n_neighbors=15, min_dist=0.1, metric='cosine', random_state=44` | ✓ shipped via umap-js (esm.sh) |
| `pacmap` | PaCMAP | n/a | — | ☐ deferred — no widely-shipped JS port; real-pipeline-only |

### 3.2 Clustering registry (additions to existing toy)

Originally registered in toy: `mutualKNN`, `hdbscan`. Real
pipeline: recursive Leiden CPM (separate codebase, not yet
ported).

| ID | Where | Status | Notes |
|----|-------|--------|-------|
| `mutualKNN` | toy | ✓ original | reciprocal k-NN connected components |
| `hdbscan` | toy | ✓ original | density-based; cuML port pending for scale |
| `connected-components` | toy | ✓ added 2026-05-10 | top-k k-NN (no mutuality), CCs; baseline |
| `leiden-cpm` | toy | pending | single-level Leiden baseline |
| `leiden-recursive` | toy + real | pending | recursive multi-level (toy already supports the multi-level shell; just needs the algorithm) |
| `infomap` | toy + real | pending | citation-flow-aware second opinion |
| `sparse-spectral` | toy + real | pending | `eigsh` on sparse Laplacian |
| `kmeans-cosine` | toy | pending | spherical k-means baseline |
| `birch-ward` | toy + real | pending | BIRCH preprocessor → Ward |
| `dpc-knn` | toy + real | pending | UP-DPC / ANN-DPC on sparse k-NN |

User has explicitly said no more *primary* clustering algorithms
are urgent for now; the multi-level + scope mechanism does most of
what was needed for sub-clustering. Adding more algorithms remains
mechanical (~50–300 lines per entry) when the need arises.

Each clustering entry declares its preferred input shape (raw
embedding, dim-reduced, sparse graph). The pipeline orchestrator
will run the right dim-reduction first once that layer is built.

### 3.3 Locked default configuration

For 810 k SPECTER2 papers, the path we're starting from:

```
1. L2-normalise the 768-d vectors

2. PCA → 100 components (denoiser)

3. UMAP → 100 components for clustering
   n_neighbors=50, min_dist=0, init='pca', metric='cosine',
   random_state=42, low_memory=True
   (Bumped from 50 → 100 per §6.9 dim-sweep validation
   2026-05-25 — ARI(50, 100) = 0.806 < 0.9 threshold on
   BFS-5000; ARI(100, 200) = 1.000 so 100 is the saturation
   point. See doc/dim-sweep-results.md.)

4. HDBSCAN on UMAP-100 output
   min_cluster_size=100, min_samples=10,
   cluster_selection_method='eom', metric='euclidean',
   prediction_data=True

5. Soft-reassign noise via approximate_predict / reduce_outliers

6. SEPARATE UMAP → 3 components for the toy's blend slider viz
   n_neighbors=15, min_dist=0.1 (NEVER used for clustering)
```

Library: `cuML` for HDBSCAN + UMAP at scale (~175× speedup vs CPU).

This is the **default**. The registry pattern means alternatives
(Leiden-on-hybrid-graph, BIRCH→Ward, sparse spectral, etc.) are
all swappable without code changes — researchers compare via the
sweep tooling.

### 3.4 Recursion + research focus targets

**Done — different mechanism from the original plan.** The
original sketched a `recluster_subset(parent_path, node_ids,
params)` verb plus per-level algorithm choice. What landed
instead is:

- **Multi-level with `scope` per level.** `scope: "global"`
  re-clusters the full dataset at finer resolution; `scope:
  "within-parent"` runs the algorithm within each previous-level
  cluster's members and stitches the results into a globally-
  numbered `ClusterResult`. User mixes both modes per level via
  the modal (workflow chart → Clustering node → + Add level).
- **Same algorithm across all levels.** Per the user's call:
  better story, apples-to-apples comparison across resolutions.
  Per-level algorithm choice was deferred indefinitely.
- **No on-demand `recluster_subset`.** Apply commits all levels
  at once. Cheap at toy scale; would need revisiting at real-data
  scale (each Apply = full pipeline rerun on 810 k).

The "research focus targets" use case is satisfied by the
within-parent scope: pick a coarse Layer 0, then Layer 1 with
within-parent scope subdivides each L0 cluster independently.

**Multi-scale boundary analysis — ✓ shipped as §6.3 bridge
analysis.** For any chosen `(fineLevel, coarseLevel)` pair, each
fine cluster carries a `byLevel[]` share breakdown against every
coarser level (not just the adjacent one) plus per-node
`boundaryScore = 1 − dominantFraction`. Surfaces as `bridge` /
`boundaryScore` colour modes in both viewers and as matching node-
table sources with a fine/coarse level-pair selector.

### 3.5 Stability metrics

Two-tier (per `clustering-research.md` §1).

**Status:** on-demand stability shipped (beta); always-visible
intrinsics still partial pending more algorithms.

**Always-visible (cheap, free)**: per-algorithm intrinsic metric.
- HDBSCAN → ✓ `stability` field per cluster (legacy contract;
  surfaces in node-table as the `stab.` column)
- Leiden → pending (modularity Q; lands when leiden registers)
- Spectral → pending (eigengap)
- k-means / GMM → pending (sampled silhouette + BIC)
- Mutual k-NN → ✓ implicit (component-size distribution visible
  via the cluster source rows in node-table)

**Cross-algorithm disagreement** is now *implicit* via the
node-table's mode-aware design: pin the table to one source
while the viewer colours by another, and disagreement is
visually apparent. Quantitative ARI across algorithms is a
follow-up; currently disagreement is qualitative.

**On-demand stability** — ✓ shipped (beta) as the **Validate tab
inside the Cluster modal** (not a standalone `Validate ▾` topbar
button as originally sketched). Bootstrap-Jaccard with Hennig
thresholds (`HENNIG_STABLE = 0.85`, `HENNIG_DOUBTFUL = 0.60`).
See §6.5 for the full surface. Beta caveat: interface and scorer
set will change.

---

### 3.6 UI infrastructure (built; wasn't in the original plan)

The original plan implicitly assumed the existing toy UI could
host every layer addition. In practice the legacy single-panel
shell couldn't accommodate multi-level clustering, mode-aware
legends, or per-layer algorithm modals. The pre-requisite work
turned into a substantial UI re-architecture, all done at toy
scale and committed under `app/src/ui/`:

| Subsystem | What it does |
|-----------|--------------|
| **Workflow chart** | SVG DAG of the pipeline (left rail). Each method node click opens its algorithm modal. State dots colour-coded fresh / stale / not-run. |
| **Multi-tab panel system** | Three slots (primary / secondary / bottom). Each holds an array of tabs with × close + + add. + opens the **panel-picker** modal listing registered panel types. Singletons (e.g. viewer-3d) filtered when already mounted. |
| **Modal infrastructure** | `modals/modal.js` (generic dialog), `modals/algorithm-modal.js` (single-level layer config — used for citation layout), `modals/clustering-modal.js` (**tabbed**: Configure / Optimise / Validate — the only modal with internal tabs today; tab strip styled to match the panel-system tab bar), `modals/dimred-modal.js` (**five-stage** — noise / fusion / compression / viz (3D) / viz2d (2D) sections, slot-filtered dropdowns), `modals/data-source-modal.js` (data-source registry picker + per-source params, opened from the workflow-chart Data card), `modals/panel-picker.js`. All modals show a `Running…` progress indicator on Apply for async work. |
| **Viewer panels** | `panels/viewer-3d.js` (3d-force-graph WebGL) and `panels/viewer-2d.js` (force-graph canvas) both delegate colour-mode resolution to `viewer-shared/colour-modes.js` — same colour-by dropdown options, same selection-dim logic, same per-cluster palette. Each reads its own positions slot (`_basePos` / `_basePos2d`) populated by the matching Layer 1.5 viz sub-stage. |
| **Eval engine** | `app/src/eval/{jaccard,bootstrap,scorers,sweep}.js` — pure functions consumed by Validate (single-config bootstrap-Jaccard, B=25) and Optimise (cross-algorithm parameter sweep). Four scorers: `ariScorer` (toy), `stabilityScorer` (Hennig), `numClustersScorer` (raw count), `clusterRichnessScorer` (count × meanJaccard, real-data default). Algorithm registry entries can mark a field `resolution: true` to opt into resolution-only sweeps (default). Hennig thresholds (`HENNIG_STABLE = 0.85`, `HENNIG_DOUBTFUL = 0.60`). |
| **Persistence** | `app/src/persistence/{manifest,serialise,deserialise}.js` — zip-format project save/load. Topbar `File ▾` menu (Save / Save as… / Load…). Strict schema-version refusal. Eval results survive across saves via `state.evalResults`. |
| **Data panel** | `data-panel.js` is the inline status / quick-edit surface for the active source. Toy: existing seed/N/origins/spread knobs + Generate ▶. Real: read-only stats + Reload ▶. Source SELECTION lives in the Data card modal, not here. |
| **Lazy-render gate** | viewer-3d shows an empty-state hint when `state._basePos` is null. Real-data ingest hits this until the user picks a 3-d viz reduction. No special gating logic — falls out of the dim-reduction contract. |
| **Layer descriptors** | `modals/layer-descriptors.js` returns `{label, openModal()}` per workflow-chart node. Adding a new layer = one new descriptor function. |
| **Mode-aware node-table** | Right-side panel that doubles as the legend for whatever's colouring the viewer. Source dropdown: Auto (follow viewer) / Cluster level N / Origin / Time / In-degree. |
| **Generalised selection** | `state.selection = {type, level?, id, …}` covering cluster (per-level), origin, node, time-bin. viewer-3d's nodeColour dimming routes by type. |
| **Colour-by dropdown in viewer-3d** | Top-left overlay; options auto-derived from current state. |
| **Camera UX** | Settings overlay (top-right), 0–1 speed sliders, no-inertia default. |
| **State container** | Vanilla `getState / update / subscribe` plus typed actions (`setTabConfig`, `addTab`, `setSelection`, `setLayerParams`, etc.). |

This work made every subsequent toy slice cheap. Future
algorithms register in one file and flow through workflow chart →
modal → engine → viewer-3d colouring → node-table legend
automatically.

---

## 4. Methods we explicitly won't implement

Brief mentions (full justifications in `clustering-research.md`
§3):

- **Mean-shift, full-covariance GMM, axis-parallel subspace
  methods (CLIQUE / SUBCLU / PROCLUS)** — fundamentally
  incompatible with SPECTER2. Mean-shift's KDE is broken in 768-d;
  full-cov GMM has too many parameters; subspace methods assume
  meaningful axes which transformer outputs don't have.
- **SSC / LRSC, ORCLUS** — linear-subspace assumption violated by
  SPECTER2's curved manifold.
- **DEC / IDEC / VaDE / SwAV** — joint encoder + clustering
  retraining; technical debt for marginal lift since SPECTER2
  already encodes citation-friendly structure.
- **Walktrap, Louvain, OPTICS, Affinity Propagation** — strictly
  dominated by registered alternatives (Infomap, Leiden, HDBSCAN,
  none-respectively).
- **Direct clustering on raw 768-d** — anisotropy + hubness break
  density methods. Always go through the dim-reduction stage.
- **t-SNE for clustering** — local-only structure preservation;
  PaCMAP is the better cousin and is registered.

---

## 5. Documentation strategy

Final shape — to converge on once integration is in flight:

- `doc/dynamics.md` — layer index. Add Layer 1.5 (dim-reduction)
  pointer.
- Per-layer specifications:
  - `doc/clustering.md` — Layer 2 (clustering)
  - `doc/citations.md` — Layer 3 (citation generation)
  - `doc/citation-layout.md` — Layer 4 (citation-driven layout)
  - `doc/blend.md` — Layer 5 (alignment + per-frame blend)
  - **NEW**: `doc/dimred.md` — Layer 1.5 specification (UMAP /
    PaCMAP / PCA / identity, contract, validator, parameters).
- `doc/scaling.md` — toy-vs-real-data scaling. Stays.
- `doc/clustering-research.md` — research record + decisions.
  Stays.
- `doc/plan.md` (this doc) — convergence roadmap. Lives until
  integration is done, then archived.
- **NEW**: `doc/method-manual.md` — user-facing manual. Walks
  through the method using the toy as a teaching tool; calls
  out what changes at scale. Written once 1–6 of §6 below are
  stable.

---

## 6. Sequencing

Each phase is independently deliverable; order is flexible.
Status legend: ✓ done · ◐ partial · ☐ pending · ↻ done differently.

### 6.0 UI infrastructure (was implicit; took a substantial slice) ✓
Workflow chart, multi-tab panels, modal infrastructure,
mode-aware node-table, generalised selection, colour-by
dropdown, camera UX, state container. See §3.6. Done over
multiple commits 2026-05-08 → 2026-05-10. Pre-requisite for
almost everything below.

### 6.1 Multi-level clustering (was item 2 + 3) ✓ ↻
`state.clusterLevels` array + global / within-parent scope per
level. Same algorithm across all levels. Modal with ± levels
done. **Different from the original plan** (no `nodePath`
contract extension, no `recluster_subset` verb, no per-level
algorithm choice) — the simpler design told a better story.

### 6.2 First new clustering algorithm registered ✓
`connected-components` lives. Demonstrates the registry-entry
pattern works end-to-end (workflow modal swap → engine cascade
→ viewer-3d recolour → node-table reflows). User has paused
adding more clustering algorithms to focus on the multi-level
analysis story.

### 6.3 Bridge analysis (the multi-scale derivation) ✓ ↻
Landed (commits 94fb467 + follow-ups). Differs from the original
sketch: the analysis went **multi-pair** rather than just adjacent
levels — for any chosen `(fineLevel, coarseLevel)` pair, each fine
cluster carries a `byLevel[]` array with one entry per coarser
level (shares + spanCount + dominantId/dominantFraction +
isBridge). The bridge / boundary-score table sources surface a
"Fine: Lx · Coarse: Ly" pair selector and a per-coarser-level
share column (`1:60% 2:25% 3:15%`) so multi-level structure (5+
layers) is legible.

What landed:
- per-fine-cluster `coarseShares` histogram per coarser level
- per-node `boundaryScore` (1 − dominantFraction at the chosen pair)
- per-fine-cluster `isBridgeAtCoarse` + aggregate `isBridgeAny`
- new `boundaryScore` and `bridge` colour modes in viewer-3d
- new `bridge` and `boundaryScore` sources in node-table with
  the level-pair selector and per-level share columns
- new `state.bridgeConfig = {fineLevel, coarseLevel}` + a
  `recomputeBridgeAnalysis()` lane that re-derives without a
  full recluster

What didn't land (deferred, low priority):
- `bridgeAdjacency` source (one row per coarse-coarse pair) — the
  per-cluster byLevel breakdown is more informative than a
  pairwise adjacency table; can revisit if a use case appears.

### 6.4 Dim-reduction layer ✓ ↻
**Shipped.** `app/src/dimred/{contract,registry,identity,pca,umap}.js`
all live. Three-stage shape (noise → compression sibling viz) with
family-array-tagged registry, modal with four stacked sections,
engine `redimred()` lane forking compression and viz off the noise
output. `identity` (any slot), `pca` (noise), and `umap`
(compression + viz) are all real algorithms — UMAP via `umap-js`
loaded over the importmap from esm.sh.

Clustering algorithms (`clustering.js`, `clustering-cc.js`,
`clustering-hdbscan.js`) refactored to read positions from the
flat `dimredResult.data` over `d` dimensions instead of reading
`basePos` directly. Cluster `centre` / `spread` are still
reported in basePos-3d viz space per the cluster contract; a
`ZERO3` fallback in each algorithm keeps clustering from crashing
when `nodes[i].basePos` is undefined (real-data path before viz
runs). A small `packBasePos()` fallback inside each algorithm
keeps the legacy shell working.

**Diverged from original plan:**
- Four stages, not two. Original §2.1 sketched noise + compression;
  viz sub-stage was deferred. Real-data work made viz load-bearing
  (it produces basePos when the data source doesn't), so it
  joined Layer 1.5 as a sibling of compression rather than a
  separate workflow node. §6.7 added a fourth sibling, `viz2d`,
  feeding the 2D viewer.
- `family` is now an array (`["compression", "viz", "viz2d"]` for
  UMAP), not a single string. Lets one algorithm register for
  multiple slots.

### 6.4a UMAP real implementation ✓
Real `umap` entry in `app/src/dimred/registry.js`, wraps
`umap-js@1.4.0` via `"umap-js": "https://esm.sh/umap-js@1.4.0"` in
the importmap. The package's `cosine`/`euclidean` helpers aren't
re-exported at the entrypoint (only `UMAP` is); we provide
inlined distance functions in `dimred/umap.js`. Determinism via
`mulberry32(random_state)` passed as the `random` param. Toy
defaults: `n_components=2, n_neighbors=15, min_dist=0.1,
metric='cosine', random_state=42`. Smoke-tested on the 1000-paper
SPECTER2 dev subset: PCA-50 (≈3.5 s) → UMAP-2 (≈1.3 s) on n=1000
× d=768.

### 6.4b Real-data ingest path ✓ ↻
**Shipped as a Layer 1 data-source registry** (see §3.0) rather
than the inline mode toggle the original sketch proposed.
`app/src/datasource/{contract,registry,toy,real}.js` make Layer 1
pluggable; `engine.reingest()` is async + mode-agnostic; switching
modes drops every downstream artifact and cascades.

**Source switching pivoted to a Data card → modal** (after a
first iteration with an inline data-panel dropdown). The Data
node in the workflow chart click-opens
`modals/data-source-modal.js`, which lists registered sources +
their per-source `modalSchema` fields. Apply triggers reingest
with a `Running…` progress button. The data panel is now an
inline status / quick-edit surface for whatever source is
already active.

Lazy-render gate landed for free: the viewer panel reads
`state._basePos`, which is null for real data until the user picks
a 3-d viz reduction. No special gating logic. Toy and real are
mutually exclusive; toy stays first-class.

`reneighbour()` bails when `_basePos` is null because the toy's
taste-network citation pipeline depends on Euclidean reasoning
over basePos. Real-data citation graph (loaded from the existing
`literture-network/` artifacts) is its own slice — when it lands,
the gate moves to "skip taste-network if mode === real".

Subset carving: `literture-network/scripts/make_dev_subset.py`
materialises a fixed-seed N-paper sample (default 1000, seed 42)
under `literture-network/artifacts/dev_subset/` — never mutates
the originals, byte-identical re-runs, provenance recorded.

### 6.4c Real citation-edge carving ✓

`literture-network/scripts/make_subset_citation_edges.py` carves
the induced citation-edge subgraph for whichever embedding subset
exists under `artifacts/<subset>/`. Reads `citgraphv2/output/edges.csv`
(raw directed citation network, 7.9 M edges, paper_key endpoints),
normalises paper_key → paper_id inline (same rules as
`build_id_mapping.py`), and writes `<subset>/citation_edges.json`:

```
{
  "meta": { subset_size, subset_seed, source, n_edges_retained,
            n_nodes_with_edges, directed, direction_convention,
            carved_at, … },
  "edges": [[src_row, dst_row], …]      subset-local 0..n-1 ids
}
```

Direction is preserved as-stored in citgraphv2 — `source_key →
target_key` follows the citation-database convention "source is
cited by target" (DBs primarily track inbound references). The
JS-side importer flips this on load to match the toy's "newer
cites older" `CitationResult.citations` convention. Provenance /
discovery_count / depth columns are dropped — QC metadata, not
topology; will live in the eventual SQL store rather than the
on-disk edge artifact.

First carve on the default 1000-paper random subset retained
3 edges across 6 nodes (0.6% coverage). Expected at this sample
size — random 1000 from 810 k shatters citation neighbourhoods.
Enough to validate the pipeline end-to-end; the connectivity-aware
follow-up is §6.4d.

Sibling slices shipped:
- `app/src/citations/importers/{registry,json-file}.js` —
  pluggable edge-import transports (file today, SQL/REST later).
  Each importer is just `fetch({dataSourceParams}) → Promise<[[src,dst], …]>`.
- `app/src/citations/imported-edges.js` — Layer 3 algorithm
  that consumes an importer and emits a `CitationResult`. Swaps
  direction (DB inbound → toy outbound) at materialisation.
- `citations/registry.js` entries grew declarative
  `needsNeighbourhoods` / `needsBasePos` / `isAsync` flags;
  `engine.reneighbour()` dispatches on those instead of the
  previous `_basePos == null` hack. New `engine.resampleViaImport()`
  lane awaits the async `infer` + contract-validates the result.
- `engine.reingest()` picks `taste-network` for toy / `imported-edges`
  for real on every source switch. `relayoutCitations()` gracefully
  degrades when basePos is null (publishes raw `citationLayout`,
  marks alignment + blend stale) instead of crashing.

### 6.4d Connectivity-aware subset carve ✓

`literture-network/scripts/make_dev_subset_bfs.py` carves a 5000-paper
subset via multi-source BFS over `citgraphv2/output/edges.csv`.
Selection method:

1. Stream edges once, build undirected adjacency + total-degree
   counts over papers that exist in the embedding index.
2. Rank by total degree. Skip the top 10 (global hubs — generic
   papers cited by everything: textbook chapters, methods classics).
3. Take the next 5 (ranks 11-15) as BFS seeds — high-degree enough
   to be well-connected, narrow enough to give the subset a topical
   spread rather than a single mono-topic cluster.
4. Multi-source BFS expansion from all 5 seeds simultaneously until
   the subset reaches `--size` papers. Deterministic visit order
   (sorted neighbour iteration) → byte-identical output.

Result at n=5000: 12,280 within-subset citation edges, 4,999/5000
papers connected (100%), mean degree 4.9. Vs the random 1000-paper
subset's 3 edges (0.6% coverage) — about 2000× more useful for
citation-graph visualisation.

UI integration: `dev_subset_bfs_5000` registered as a second subset
in `app/src/datasource/real.js`; data-source modal dropdown shows
both options with friendly labels.

Headless-smoke-tested end-to-end: BFS subset → reingest (~3 s data
fetch) → imported-edges loads 12,268 citations → UMAP-3 viz at
n=5000 → HDBSCAN clustering (2297 clusters at default min_cluster_size
— overly granular at this scale; needs param tuning) → FR layout →
alignment (correlation 0.52). Zero page errors.

Known scale issues (deferred to §6.11 below):
- UMAP-3 at n=5000 freezes the page for 30-90 s (synchronous JS,
  no event-loop yields). Browser shows "page unresponsive" warning.
- HDBSCAN default `min_cluster_size` is tuned for toy n=400; at
  n=5000 it produces ~2300 clusters (mostly singletons). Either
  needs source-aware defaults or sweep via the Optimise tab.

### 6.11 Web Worker port for heavy compute lanes ✓ — **Slices 1–3 shipped (2026-05-23)**

**What landed:** Slices 1–3 of the DAG-based worker port. The three
heavy lanes (`redimred`, `recluster`, `relayoutCitations`) all run
their compute in module workers via a generic `runDAG` walker. Toy
mode is unaffected; at BFS-5000 + HDBSCAN the main thread stays
responsive throughout the ~18 s clustering pass.

Files:
- `app/src/workers/{worker-runner, dag, dimred-worker, clustering-worker, layout-worker}.js` — runner, DAG walker, three module-worker entries.
- `app/src/clustering-cascade.js` — multi-level cascade extracted from `engine.js` so the clustering worker can re-use the same code on the worker thread.
- `app/src/ui/engine.js` — all three lanes now `async`, build DAGs, await `runDAG`.
- `app/src/ui/modals/{algorithm-modal, clustering-modal, layer-descriptors}.js` — modal Apply now shows `Running…` and stays open until the async cascade resolves.
- `app/src/dimred/umap.js`, `app/src/citation-layout/umap-graph.js` — full esm.sh URLs (not bare specifiers) so workers load identically to the main thread.

Two follow-up bug fixes landed alongside (both pre-existing
regressions exposed by the move off the main thread):
- **Multi-level cluster dropdown** — `recluster()` now bumps
  `engineRevision` so the viewer's colour-by dropdown refreshes
  when levels are added/removed. Without it the DAG version
  silently left the dropdown stuck at one level.
- **Fusion slider when no citation layout** — `blend/blend.js`
  used to bail entirely when `alignedCitationLayout` was null
  (the default state since §6.16 made citation layout opt-in).
  Now the inner pre/post-fusion lerp drives the viewer even
  without citation layout — the outer α just forces to 0.
- **`setLayerState("X", "running")`** at the start of each async
  lane so the workflow chart shows in-flight work as orange while
  workers crunch. Pre-DAG the page-freeze itself was the progress
  signal; workers fixed responsiveness but exposed this gap.

**Slice 4 (progress reporting)** still ☐ — deferred until §6.13
busy pill lands or per-epoch UMAP progress becomes load-bearing.

**Pending follow-ups** (issues observed but not blocking):
- **Optimise → Validate hop is fire-and-forget.** `clustering-modal.js`'s `onApplyRow` calls `descriptor.applyChange(...)` then `setActiveTab("validate")` without awaiting. User lands on Validate tab while the apply is still in flight; if they hit Run, they validate stale clusters. Either gate Validate's Run button on `layerStates.clustering === "fresh"`, or show a Running indicator on the tab during in-flight apply.
- **Optimise / Validate tab `algo.infer` calls still sync.** The eval surface (`app/src/eval/{bootstrap,sweep}.js`) calls `algo.infer` directly, not via the worker. Heavy sweeps (HDBSCAN × resolution grid at BFS scale) still freeze the page. Treat as a Slice 5 candidate: pipe the eval surface through workers too.

See `RESUMING.md` (committed at the repo root) for the design
notes + the postmortem of the two demo-night bugs that pushed us
to revert + re-merge.

**Background (kept for posterity):**
UMAP, HDBSCAN, and FR all used to run synchronously on the main
thread. At n=400 (toy) that's invisible; at n=5000 (BFS subset) the
page became unresponsive for 30-90 s during each lane.

**Locked decisions (2026-05-20):**
- **Per-algorithm workers, lane-orchestrated.** Each algorithm
  (UMAP, HDBSCAN, FR, UMAP-on-graph, graph-diffusion) gets its
  own worker entry; lanes (`redimred`, `recluster`,
  `relayoutCitations`) compose worker calls.
- **Explicit DAG description per lane (Option B).** Each lane
  declares its compute graph as a small data structure; a generic
  walker (`runDAG`) topologically sorts, fires independent nodes
  into workers in parallel, threads results. Chosen over inline
  `Promise.all` (Option A) to set up consistent introspection /
  cancellation / progress-reporting across the whole engine and
  to make future branchy lanes cheap. Overkill for today's
  mostly-sequential lanes (`recluster`, `relayout`) is accepted —
  they get the same shape as `redimred` for free, and growing
  parallelism in them later costs nothing.
- **Module workers + esm.sh URLs.** `new Worker(url, { type:
  'module' })`; workers import `umap-js` directly from the same
  esm.sh URL the page's importmap uses. No bundling step.
- **Transferable TypedArrays.** All `Float32Array` / `Int32Array`
  payloads use the `[buffer]` transfer list, not structured clone.
  At n=5000×768 we'd otherwise copy ~15 MB per call.
- **Spawn-per-call, no pool.** Worker spawn is ~10 ms; UMAP is
  seconds. Revisit only if profiling shows spawn cost mattering.
- **Cancellation: `AbortSignal` → `worker.terminate()`.** Each
  `runDAG` call takes an optional signal; if aborted mid-run, all
  in-flight workers are terminated. Engine wires a per-lane
  `AbortController` so re-firing a lane mid-flight cancels the
  prior run.
- **Determinism preserved.** Workers don't change `mulberry32`'s
  output (same seed → same sequence). Smoke-test anyway.

**Architecture:**

```
app/src/workers/
  worker-runner.js     — runInWorker(moduleId, payload, signal?) → Promise<result>
  dag.js               — runDAG(dag, signal?) → Promise<{nodeName: result, ...}>
  dimred-worker.js     — module worker entry, dispatches on payload.algo
  clustering-worker.js — module worker entry
  layout-worker.js     — module worker entry
```

Each worker entry is a thin dispatcher: receives `{algo, input,
params}`, imports the relevant algorithm module, calls it, posts
the result back with the output `ArrayBuffer`s in the transfer list.
The algorithm modules themselves (`dimred/umap.js`, etc.) stay
unchanged — they're already pure functions with no DOM access.

`runDAG(dag, signal?)` walks the DAG:
1. Topologically sorts nodes by `inputs` dependencies.
2. For each ready batch (all `inputs` resolved), fires
   `runInWorker` calls in parallel via `Promise.all`.
3. Threads outputs into dependent nodes as their inputs resolve.
4. Returns `{nodeName: result, ...}` when all nodes complete.
5. Honours `signal.aborted` between batches; on abort, terminates
   all in-flight workers.

**Sequencing within §6.11:**

1. **Slice 1 — runner + DAG + UMAP.** Build
   `worker-runner.js`, `dag.js`, `dimred-worker.js`. Port
   `dimred/umap.js` (and `dimred/graph-diffusion.js` while we're
   at it — they share the worker entry). Convert `redimred()` to a
   DAG: noise → fusion → {compression, viz, viz2d} in parallel,
   plus {compression-pre, viz-pre} in parallel when fusion is
   active, plus Procrustes (main thread) at the end. Smoke at
   n=5000: page stays responsive; sibling parallelism shaves total
   redimred from ~25 s to ~10 s.
2. **Slice 2 — HDBSCAN.** Add `clustering-worker.js`; port
   `clustering-hdbscan.js`. Convert `recluster()` to DAG form
   (mostly a sequential chain across cluster levels — DAG is
   overkill but uniform with `redimred`).
3. **Slice 3 — FR + UMAP-on-graph.** Add `layout-worker.js`;
   port `citation-layout/{fr,umap-graph}.js`. Convert
   `relayoutCitations()` to DAG form (single node — DAG is silly
   here but cheap and uniform).
4. **Slice 4 (optional) — progress reporting.** umap-js exposes
   per-epoch progress; pipe it through the worker as
   `postMessage({progress})`. `runDAG` aggregates and emits via
   the §6.13 busy pill ("UMAP epoch 124/500" instead of just
   "Running…"). Defer unless §6.13 needs it.

**What this does NOT solve:**
- HDBSCAN at n=5000 producing 2300 clusters with default
  `min_cluster_size` — param-tuning issue, independent of workers.
- §6.15 fusion path running UMAP twice — workers parallelise the
  two halves (good), total work unchanged.

Defer the full slice work until on a machine with enough headroom
to test at n=5000+. Smaller subsets (n=1000) don't trigger the
warning and the toy stays fast.

### 6.12 User-supplied data import (file browser) ☐ — **deferred**

**Deferred (2026-05-20).** The shape of incoming data will change
when the new databasing system lands; building a file-picker
against today's `paper_index.json` + `citation_edges.json` would
just need rewriting against the DB-backed source. Revisit once
the DB layer is set. Spec below preserved for that revisit.

Two new entry points so the user doesn't have to drop files under
`literture-network/artifacts/` (or re-fetch them) every time they
want to work with a different dataset. Both flows open a native
file picker; both share a thin FileReader-based adapter layer
underneath. Distinct from today's `File ▾ → Load…` (which
restores a **full project** — config, dim-reduction output,
clusters, eval results, everything — and intentionally skips the
engine cascade): here the user is choosing **data only**, and
the cascade re-runs from dim-reduction onward.

**Flow A — Reload data from saved project archive**
- New menu item: `Data ▾ → Load dataset from project archive…`
  (currently the stubbed `Load real dataset…` slot in
  `topbar.js:29` can be repurposed).
- User picks a `.zip` the Save function produced (same format as
  `File ▾ → Load…`).
- Deserialise via the existing `persistence/deserialise.js`, but
  keep only the data slots: `dataSource`, `genResult`,
  `embedding`, `citationResult.citations`. (`_basePos` kept only
  in toy mode — real mode regenerates it from the embedding via
  Layer 1.5's viz sub-stage.)
- Drop everything downstream: `dimredResult`, `_basePos2d`,
  `clusterLevels`, `bridgeAnalysis`, `neighbourhoodResult`,
  `tasteResult`, `citationLayout`, `alignedCitationLayout`,
  `alignmentCorrelation`, `evalResults`, `layerStates`,
  `selection`, `blend`. Keep `panels` (UI shape) and
  `layerParams` (so the user's algorithm picks survive).
- Engine cascade runs post-load (inverse of today's Load…) —
  `redimred()` → `recluster()` → `reneighbour()` etc. all re-fit
  from the restored data using current params.
- Use case: re-analyse a captured dataset with different
  clustering params; cheaper than re-fetching SPECTER2 artifacts
  over HTTP; portable (the `.zip` is self-contained).

**Flow B — Import local real-data files (bring-your-own)**
- New menu item: `Data ▾ → Load dataset from local files…`.
- Opens a modal with three file pickers:
  - `embedding.npy` (required) — parsed by the existing
    `parseNpy()` in `datasource/real.js` (`<f4` dtype only;
    bumping that is a separate task).
  - `paper_index.json` (required) — row-index → paper_id map,
    same shape as
    `artifacts/<subset>/expanded_embeddings_paper_index.json`.
  - `citation_edges.json` (optional) — same shape as
    `artifacts/<subset>/citation_edges.json`. Skipped → no
    imported citations; the user can layer them in later via
    the citation-import path that already exists.
- Files read via `<input type="file">` + `FileReader`
  (`.arrayBuffer()` for .npy, `.text()` for JSON). Zero fetch
  calls — the static server URL convention doesn't apply.
- Imported edges flow through the existing
  `citations/importers/json-file.js` so the direction-flip +
  dedup logic isn't forked.
- Files held as in-memory `File`/`Blob` handles for the session
  only. Not persisted unless the user runs Save (in which case
  the embedding payload lands in the `.zip` via the existing
  state-save path — same as today's real-source projects).

**Topbar wiring**
- `File ▾ → Load…` — unchanged. Full-project restore, results
  preserved, cascade skipped.
- `Data ▾ → Load dataset from project archive…` — Flow A
  (replaces the disabled `Load real dataset…` stub).
- `Data ▾ → Load dataset from local files…` — Flow B (new).
- The existing workflow-chart Data card stays as the config
  surface for the **active** source (toy params / current real
  subset); Flow B just adds `"local"` as a third data-source
  registry entry that the modal can surface alongside `toy` and
  `real`.

**New files**
- `app/src/persistence/data-only-load.js` — wraps
  `deserialiseFile()`, filters the result down to the data
  slice, returns a partial state suitable for engine consumption.
- `app/src/datasource/local.js` — produces a `DataSourceResult`
  from `{embeddingFile: Blob, indexFile: Blob, edgesFile?: Blob}`.
  Registered alongside `toy` / `real` in
  `datasource/registry.js`.
- Engine grows `applyDataOnlyState(partial)` (or the topbar
  threads through `setActiveSource` + reingest) — takes the
  restored data, clears downstream slots, runs the cascade from
  `redimred()` onward.

**Open questions**
- Flow A: should `layerParams` survive the data-only load, or
  reset to per-source defaults? Surviving is friendlier
  (returning to the same view) but risks param/data mismatch
  (e.g. UMAP `n_components=50` on a freshly-loaded toy dataset
  that has no embedding). Lean: keep `layerParams` but
  validate-and-reset any slot whose source-vs-data combination
  is no longer coherent.
- Flow B: where does this dataset's identity live for the Save
  round-trip? Current `dataSource` slot expects
  `{ method: "real", subset: "dev_subset_bfs_5000" }` — a
  per-file source has no `subset` id. Either invent a synthetic
  id (`"local"` + hash of filenames) or grow the dataSource
  schema with an explicit `localFiles` shape. Lean: explicit
  shape, so saved projects can still round-trip
  (embedding/index/edges all inlined into the `.zip` already via
  the existing TypedArray-payload path).
- File-picker UX inside the modal: native `<input type="file">`
  styling varies by platform. Lean: thin custom wrapper button
  → input is hidden, label shows selected filename, matches the
  existing modal visual rhythm.
- Engine guard: when the user picks an embedding-only set
  (no citations file), the citation lanes already bail correctly
  on `_basePos == null` — no extra work. Worth a smoke test
  before claiming done.

**Smoke acceptance** (toy-only — per memory rule on no real
data in tests)
- Toy → Save → reload page → `Data ▾ → Load dataset from
  project archive…` → pick the .zip → cascade re-runs → final
  cluster count + basePos match the saved values up to seed
  (param-equivalent, not byte-identical, because cascade re-fits).
- Local files: tested manually with the existing
  `artifacts/dev_subset/*` files copied to a temp directory,
  loaded via the picker. Same n, same edge count as a normal
  `real` reingest.

### 6.13 Global busy indicator + queue ✓ ↻ — shipped 2026-05-24

**Shipped as a bottom status bar + FIFO queue**, not a topbar pill
as originally sketched. The visual surface lives at the viewport
bottom (`#busy-bar` in `app/index.html`); the queue + label control
live in `app/src/ui/busy.js` (`enqueueBusy` + `setBusyLabel`).

Why a queue instead of a single slot: once workers (§6.11) made the
heavy lanes truly async, users can fire multiple actions back to
back — open the dim-reduction modal + Apply, then open the
clustering modal + Apply before the first finishes. The modal Apply
closes immediately and the bottom bar carries all in-flight
feedback, showing `+N queued` when more are waiting. The
cascade-aware `setBusyLabel("Loading data…" → "Dim-reduction…" →
"Clustering…" → "Citations…")` updates the head label as the
engine walks each step, so the bar reads "the current step" rather
than a generic "Running…".

**Failure semantics**: if a job throws, the error propagates out of
the `enqueueBusy` promise but does NOT poison the queue — the next
job still runs. Callers handle errors via existing try/catch
patterns in modal applyChange paths.

**Wired into**:
- Engine cascade (`engine.js`): every async lane sets a fresh label
  at each phase (`reingest` → `redimred` → `recluster` →
  `reneighbour` → `relayoutCitations`).
- Topbar Save / Load (`topbar.js`): wraps `saveProject` / `loadProject`.
- Modal Apply paths (dim-reduction, clustering, algorithm,
  data-source modals): each enqueues, modal Apply closes immediately.

**What we deliberately didn't build**:
- No progress bar with %. UMAP is the worst offender; no per-step
  timing model yet. Per-epoch progress reporting is a §6.11 Slice 4
  follow-up.
- No toast notifications. Success is self-evident; failure already
  pops `window.alert` in the existing handlers.
- No `pointer-events: none` lockout — workers + the queue handle
  back-to-back actions gracefully now, the lockout would be more
  annoying than useful.

**See `doc/ui-architecture.md` §12** for the queue mechanics +
state shape; **previous spec preserved below for reference.**

#### Previous spec (preserved for context)

**Prior art (reuse, don't reinvent)**
- CSS animation: `@keyframes modal-action-running` in
  `app/styles/*.css:1023` — the sweeping shimmer used on
  `.modal-action.running` and `.cm-tab-run.running`.
- Pattern: `btn.textContent = "Running…"; btn.classList.add("running")`
  bracketed around an `await`. Used by `dimred-modal.js`,
  `data-source-modal.js`, `clustering-tabs/{validate,optimise}-tab.js`.

**What's new**
- `state.busy = null | { label: string, since: number }` — single
  global slot. `null` = idle; otherwise the topbar shows a pill.
- Topbar busy pill: a small inline element next to the project
  name (or in a fixed slot — `topbar.js` decides where it fits
  visually). Reuses the `modal-action-running` keyframes so the
  shimmer matches modal buttons exactly. Hidden via
  `display: none` when `state.busy === null`.
- Topbar subscribes to `state.busy` via the existing
  `subscribe()` plumbing — same shape as how `projectName`
  re-renders today.
- Wrapping helper: `withBusy(label, async fn)` in `ui/busy.js`:
  ```
  setBusy({ label, since: Date.now() });
  try   { return await fn(); }
  finally { setBusy(null); }
  ```
  All call-sites use this — no manual try/finally pairs in
  `topbar.js` or anywhere else.
- Optional `pointer-events: none` on the workflow chart + menus
  while `busy !== null` so the user can't trigger a second
  long action mid-flight. (Open question — might be more
  annoying than useful at toy scale; revisit.)

**Call-sites to wire**
- `topbar.js:181` `saveProject()` → `withBusy('Saving "${name}"…', …)`.
- `topbar.js:204` `loadProject()` → `withBusy("Loading…", …)`.
- §6.12 import flows (when built) → same wrapper, labels
  `Importing data…` / `Reading files…`.
- Engine `reingest()` is already covered by the data-source
  modal's Apply button spinner; **don't** double-cover it.

**What we explicitly don't build**
- No progress bar with %. We have no per-step timing model, and
  the worst offender (UMAP at n=5000) needs the §6.11 worker
  port before a meaningful % is possible.
- No toast notifications. Success is self-evident (state
  applies, viewers repaint); failure already pops `window.alert`
  in the existing handlers.
- No per-phase labels for Load ("Unzipping…" → "Applying
  state…"). First cut keeps it as a single label per action;
  break it down only if a phase turns out to dominate.

**Smoke acceptance**
- Toy Save → pill flashes briefly (<100 ms is fine; it's still
  visual confirmation the click registered).
- BFS-5000 Save / Load → pill visible for the few seconds the
  zip step takes; disappears when state applies.
- Click another menu item while busy → no-op (if the
  pointer-events guard lands) or doesn't crash (if it doesn't).

### 6.14 Citation layout for sparse large-scale graphs ✓ ↻ — **partial**

**Shipped:**
- **Year propagation end-to-end** (`make_dev_subset.py`,
  `make_dev_subset_bfs.py`, `app/src/datasource/real.js`). Both
  carvers read `citgraphv2/output/nodes.csv` year column, write
  `paper_years.json` alongside the embedding index. `real.js`
  fetches the years file and normalises to `t ∈ [0, 1]` per
  subset year range (newest → 1, oldest → 0). BFS-5000 re-carved:
  100% year coverage, range 1954–2026, 23 distinct year values.
  Removes the symmetric-anchor failure mode from FR; doesn't fix
  the sparsity-driven sphere on its own.
- **UMAP-on-citation-graph** (`app/src/citation-layout/umap-graph.js`).
  Symmetrises adjacency, builds precomputed k-NN via BFS-layer
  expansion (self at idx 0 with d=0 per umap-js convention, then
  hop-1, hop-2 padding for low-degree nodes), feeds umap-js's
  `setPrecomputedKNN`. Tested on BFS-5000: layout converges in
  ~5–15 s, alignment correlation ~0.53 (vs FR's ~0.51 — both
  views encode distinct information, blend is meaningful).
  No spherical shell, no nested orbitals — preserves local
  citation neighbourhoods rather than global pairwise distances.

**Still pending** (medium-term, in original ranked order):
- **Pivot MDS** — replaces classical MDS at scale with a low-rank
  pivot approximation. Carries the graph-distance-preservation
  intent forward without the m²-BFS cost.
- **Spectral layout** — low-eigenvectors of the graph Laplacian.
  Substantial work without an off-the-shelf JS sparse-eigsh.
- **Barnes–Hut FR** — preserves FR's force formulation including
  the now-working cladogram time anchor; only the all-pairs
  repulsion sum changes (octree approximation, `O(n log n)`).

Defer all three until UMAP-on-graph proves load-bearing for
real-data exploration; if it doesn't, the next pick depends on
which structural property the user finds it missing
(reproducibility-of-runs ⇒ Pivot MDS; large-scale topology
fidelity ⇒ spectral; preserving FR's cladogram semantics
exactly ⇒ Barnes–Hut).

**Observed at BFS-5000 (n=5000, |E|=12268, density ~0.001) — pre-fix baseline:**
- FR collapsed to a **uniform spherical shell** — every node
  pushed against `wallR = R · outerWallFraction` by repulsion
  because attractive forces from ~5 edges per node weren't enough
  to balance the all-pairs `O(n²)` repulsion at this density.
  Doc `citation-layout.md:136-140` already calls this out as the
  expected failure mode for sparse graphs (it cites density 0.05
  as the trigger; we're 50× sparser).
- MDS produced a structured **electron-orbital / concentric-shell
  pattern** — the graph-distance matrix at this size and sparsity
  is dominated by a few top eigendirections, so SMACOF converged
  to nested-shell embeddings. Plus n=5000 is near the m²-BFS
  tractable ceiling for in-browser MDS (25 M distance cells), so
  convergence quality was poor.
- Compounded by `produceReal()` writing `t: 0` for every node
  (`paper_index.json` carried no publication years), so FR's
  time-axis anchor degenerated to "uniform inward pull on all
  nodes" — rotationally symmetric, sphere as only stable
  equilibrium.

**Short-term mitigations — resolved.** The t=0-everywhere
degeneracy is fixed: both carvers now emit `paper_years.json` and
`real.js` normalises to `t ∈ [0, 1]` per subset (see "Shipped"
above). FR's cladogram anchor recovers real semantic structure on
BFS-5000. The sparsity-driven sphere itself isn't fixed by
year propagation alone — UMAP-on-graph (also shipped) is the
recommended algorithm at this density; the medium-term picks
below remain the path forward for FR-formulation-specific or
graph-distance-preservation work.

**Medium-term: new layout algorithms for scale.** The scaling
doc (`doc/scaling.md` §2.4.2) already enumerates the alternatives
worth registering in `citation-layout/registry.js`. In rough
order of bang-for-effort at n=5–50k:
- **Pivot MDS** (Brandes & Pich 2007) — pick `p ≈ 50–500` pivot
  nodes, BFS from each (`O(p · |E|)`), embed pivots exactly,
  triangulate the rest. Carries the graph-distance-preservation
  idea verbatim with low-rank approximation. Tractable at any size.
- **Spectral layout** — low-eigenvectors of the graph Laplacian
  (`sparse eigsh` equivalent in JS). Captures large-scale
  topology rather than per-pair distances. Linear-ish on sparse
  graphs.
- **UMAP on citation graph** (`umap-js` with a precomputed
  k-NN graph from citations). Reuses the same library already
  loaded for the dim-reduction layer. Mathematically not MDS,
  but for visualisation it's often what users actually want.
- **Barnes–Hut FR** as a last resort if we want to keep FR's
  formulation. Octree-approximated repulsion takes the all-pairs
  sum from `O(n²)` to `O(n log n)`. Doesn't fix the cladogram-
  anchor degeneracy; that's a separate issue.

Each new algorithm slots in as a new entry in
`citation-layout/registry.js` with `{ id, defaultParams, compute,
modalSchema }` — same shape as `fr` and `mds`. The blend / align
contract is unchanged: any 3-d positional array works.

**Open question — which scoring metric for cross-layout sweep?**
The eval surface (§6.5) currently sweeps clustering algorithms.
Citation-layout has no analogous quality metric registered.
Candidates: alignment correlation against basePos, edge-crossing
count, neighbourhood-preservation precision-recall (Venna &
Kaski 2001). Don't pick yet — wait until at least two new
algorithms are registered so the choice has real candidates to
compare. The eval-surface infrastructure should generalise so
"sweep over citation-layout algorithms" becomes a third tab in
the layout modal without re-implementing the sweep engine.

### 6.15 Citation-aware embedding fusion (Layer 1.5 sub-stage) ✓ ↻ — **MVP shipped**

**Decisions locked at implementation:**
- Toy mode: fusion=identity (no two-pass; real-data validation only). Toy ARI-vs-origins regression deferred to future.
- Default noise stage: PCA-100 (per user reasoning — denoise first, then add citation information to the cleaner representation).
- Adjacency: symmetric (A ∨ Aᵀ). Asymmetric is a one-line future toggle.
- Save schema: no bump. Old archives load with `fusion = identity` defaulted in.
- Algorithm: APPNP-style anchored diffusion `X' = (1−α)X + α(D⁻¹A)X'`, α as "mixing strength" (right = more fusion). Note the inverse-convention from the published APPNP paper (theirs α = teleport probability).
- ~~Layout-cache optimisation deferred (every fusion-param tweak still re-runs UMAP-on-graph wastefully).~~ Subsumed by §6.16 — the cascade no longer auto-runs citation layout on fusion-param changes.

**Files touched:**
- `app/src/dimred/graph-diffusion.js` — new algorithm.
- `app/src/dimred/registry.js` — entry registered, `family: ["fusion"]`.
- `app/src/datasource/real.js` — `produceReal()` fetches `citation_edges.json` at ingest, returns flat number[].
- `app/src/ui/state.js` — `state.rawCitationEdges` slot (replaces null in toy mode).
- `app/src/ui/engine.js` — `ensureLayerParams` adds fusion slot (default identity) with backwards-compat fix for older states; `reingest` caches `rawCitationEdges`; `redimred` runs fusion as Stage 1.5 between noise and the (compression / viz / viz2d) sibling triple. All three siblings read from fusion output.
- `app/src/ui/modals/dimred-modal.js` — 5th section ("Citation-aware fusion") between noise and compression.
- `app/src/persistence/serialise.js` — `rawCitationEdges` saved as `Int32Array` payload so loaded projects retain the citation graph for post-load fusion-param changes.

**Wasteful double-fetch:** the citation graph is fetched twice on real-data reingest — once by `produceReal()` for the fusion cache, once by `imported-edges` for Layer 3. HTTP cache covers the second hit so the wire cost is single-shot, but the JSON parse runs twice (~50ms at n=5000). Acceptable for MVP; tighten by having imported-edges prefer `state.rawCitationEdges` later.

**Fusion-comparison slider — shipped as part of 6.15.** Mirrors the
existing per-frame blend but on the *fusion* axis. Two independent
sliders now sit in the left rail under Blend:
- `α` (existing) — basePos ↔ citation-topology layout.
- `fusion` (new) — pre-fusion basePos ↔ post-fusion basePos.
The hook in `blend/blend.js` is now a nested lerp; the four corners
of (fusion, blend) space let the user walk between (semantic-only,
citation-aware, citation-aligned-to-semantic-only,
citation-aligned-to-citation-aware) positions.

When fusion is non-identity, `redimred()` runs compression + viz
*twice* (once on noise output, once on fusion output) and
`recluster()` clusters both — populating `_basePosPreFusion`,
`dimredResultPreFusion`, `clusterLevelsPreFusion`. The fusion-slider
row in the left rail auto-hides when those are null (toy mode,
identity fusion). New colour-mode "Cluster — pre-fusion (level i)"
shows up in the dropdown so the user can paint nodes by their
pre-fusion cluster IDs while dragging the fusion slider — directly
visualising how citation context reorganised the topic map.

**Cost note**: a fusion-enabled redimred now runs ~2× the UMAP-3 +
UMAP-50 work (one pre-fusion path + one post-fusion path) plus
parallel clustering. At n=5000, total redimred climbs from ~25 s to
~45 s. Acceptable for MVP exploration; §6.11 workers cut both
halves of the doubled work in parallel later.

**Pre-fusion → post-fusion Procrustes alignment.** UMAP picks an
arbitrary rotation per fit, so two UMAP-3 runs on near-identical
embeddings produce same-topology, different-orientation layouts —
linear interpolation between them sends points spinning through
nonsense intermediate paths. Fix: new `alignGlobal()` in
`blend/align.js` (whole-graph Horn-quaternion + match-RMS scale +
translation; same machinery as `alignByComponent` but called
once over the entire node set, no edges argument). Called from
`redimred()` after both basePos versions are computed; the
fusion-comparison slider's lerp now walks the short geometric
path between the two layouts.

### 6.16 Citation layout made opt-in ✓

The pipeline cascade used to auto-trigger `relayoutCitations()`
after every Layer 3 update — including every fusion-param change,
which wastes 5–15 s on UMAP-on-graph at n=5000 when the citation
edges haven't actually changed. Now the cascade STOPS at Layer 3.
`markCitationLayoutStale()` clears `citationLayout` /
`alignedCitationLayout` and marks layout/alignment/blend layer
states as `"stale"`. User explicitly applies via the Citation
Layout modal (existing `applyChange()` in `modals/layer-descriptors.js`
already calls `engine.relayoutCitations()` directly).

Workflow chart's status dots now correctly show orange for those
three layers until the user applies. The `α` slider is inert
until alignment has run — blend hook bails when
`alignedCitationPos` is null, so the viewer stays at basePos.

Subsumes the layout-cache optimisation that was deferred as a
§6.15 follow-up.

### 6.17 Target-range sweep (Optimise tab strategy 3) ✓ — shipped 2026-05-24

Third sweep mode in the Optimise tab, alongside Resolution only
and Full grid. Shipped on branch `feat/target-range-sweep` (commit
3b1716f). Implementation: `app/src/eval/sweep.js`
(`runTargetRangeSweep`) + `app/src/eval/lhs.js` (Latin hypercube
sampler) + the Target range radio + settings panel in
`app/src/ui/modals/clustering-tabs/optimise-tab.js`.

**Motivation.** Full-grid sweeps explode at real-data scale; even
resolution-only enumerates every value the algorithm registry
declares on the resolution-tagged axes. When the user already
knows *roughly how many clusters they want* (typical research
workflow — "I want ~30 topical groups, find me the most stable
params that land there"), neither cartesian sweep is well-targeted.
Target-range turns the search into a **directed hunt** for a
cluster-count band.

**Algorithm (two-phase).** For each enabled clustering algorithm:

1. **Phase 1 — Latin hypercube probe.** Sample `phase1Count`
   configs across the resolution-tagged fields. Each numeric field
   is divided into `phase1Count` equal-probability bins; one value
   is drawn from each bin, then per-field sequences are
   independently Fisher-Yates shuffled so the joint distribution is
   space-filling (no two samples share a bin on any axis). Per-
   field scale honours `field.scale === "log"` for orders-of-
   magnitude coverage (e.g. HDBSCAN `min_cluster_size`); integer
   fields round + clamp + dedupe; select fields cycle options.
   Run each config's `algo.infer(...)`, record cluster count, mark
   `inRange` iff `targetMin ≤ nClusters ≤ targetMax`.

2. **Phase 2 — neighbourhood refine.** For each Phase-1 hit,
   generate neighbour configs by perturbing each int/range
   resolution field by `±refineStep` clamped to its field range.
   Dedupe across overlapping hit neighbourhoods (stable-stringified
   params as the cache key). Re-run `algo.infer(...)` on each
   neighbour.

**Scoring (Phase 2).** Two modes:
- **Proximity (default)** — `primary = 1 / (1 + |nClusters − midpoint|)`
  where midpoint = `(targetMin + targetMax) / 2`. Configs that land
  in the centre of the band rank highest; overshooters fall off.
- **Reproducibility (`runBootstrap=true`)** — bootstrap-Jaccard each
  Phase-2 candidate (`eval/bootstrap.js`), `primary = aggregate.meanJaccard`.
  Slower but reveals which target-range configs are most stable
  under resampling.

Ranking: in-range first (descending primary), out-of-range second
(refineStep can walk a hit just outside the band; those rows stay
visible but rank below the hits).

**Fusion-aware "Sweep against" toggle.** When `state._basePosPreFusion`
exists (fusion is active), an extra radio appears: **Post-fusion** /
**Pre-fusion** / **Both**. "Both" runs the whole two-phase sweep
twice — once on `dimredResult`, once on `dimredResultPreFusion`,
each pass tagged with its source. The merged ranked list shows a
**Source** column so the user can compare which params win on each
representation side-by-side. The auto-collapse to "Post-fusion" when
no pre-fusion buffer exists keeps the UI clean in toy mode.
Distinct LHS seeds per pass (42, 42+1009, …) so the two passes
don't collide on identical samples.

**State + caching.** Same `state.evalResults.optimise` slot as the
other sweep modes; persistence via the existing serialise path.
`scorerId` records `"target"` or `"target+bootstrap"`; settings carry
`{ targetMin, targetMax, phase1Count, refineStep, runBootstrap,
sweepAgainst }`. Cached results re-render on tab hop + project load.

**Smoke tests** (under `scratch/`):
- `lhs_unit_smoke.py` — sampler determinism + bin coverage + log
  scale + Fisher-Yates shuffle stratification.
- `target_range_smoke.py` — end-to-end target-range run at toy
  scale; asserts hit-count > 0 in a sensible band.
- `target_range_bootstrap_smoke.py` — same, with reproducibility
  scoring enabled.
- `target_range_ui_smoke.py` — UI surface (Target range radio,
  range inputs, source toggle visibility).
- `sweep_against_smoke.py` — Pre / Post / Both source toggle.

**Pending follow-ups:**
- LHS sampling could also drive the resolution-only and full-grid
  modes for cheaper coverage at high config counts — currently they
  enumerate cartesian. Decide when one of those modes becomes the
  bottleneck.
- Phase-1 vs Phase-2 progress reporting in the status line is
  per-config; aggregate ETA across both phases would be friendlier
  for long runs at BFS-5000.

**Still pending (follow-ups carried over from §6.15):**
- ~~Layout-cache (skip UMAP-on-graph recompute when citation edges haven't changed but fusion params have)~~ — subsumed by §6.16's opt-in design.
- Asymmetric adjacency toggle.
- Two-pass toy mode (taste-network feeds fusion on a second pass).
- Cross-view NMI metric (quantify the cluster-label diff between fusion=identity and fusion=graph-diffusion runs).
- Sweep tooling extension for cross-fusion-α comparison.

**Motivation.** §6.14 showed UMAP-on-citation-graph and UMAP-on-
SPECTER2 produce visually different layouts with alignment
correlation ~0.53 — the two signals carry genuinely different
information. The current architecture treats this as a
**positional blend at render time** (Layer 5b: per-frame lerp
between two 3-d layouts). What that *can't* answer is:

> What does the topic map look like if we let citations
> inform the embedding *before* clustering?

The blend is a comparison; fusion is an integration. Without
fusion we can only ask "do these two views agree?"; with fusion
we can ask "what new topical structure emerges when both signals
are combined into one representation?" The α slider on the
fusion modal becomes the actual research instrument — the user
walks from pure semantic embedding to citation-enriched
embedding and watches clusters reorganise.

**Architectural placement.** New sub-stage in Layer 1.5 (the
dim-reduction registry), between `noise` and `compression`:

```
embedding (768) ─▶ noise (768) ─▶ fusion (768) ─▶ compression (50) ─▶ clustering
                                  ↑
                                  reads citation graph here
```

This sits naturally in the existing registry pattern: same
`{ id, label, description, defaultParams, compute, modalSchema,
family }` shape as every other dim-reduction algorithm. The
fusion stage's `family` is `["fusion"]` (slot-aware defaults).
Default algorithm: `identity` (pass-through, no fusion);
opt-in via the modal to `graph-diffusion`.

**Algorithm: graph diffusion (first entry).** Standard label-
propagation / heat-equation discretisation applied to feature
vectors:

```
X'⁽⁰⁾ = X                                  (input embedding, n × d)
X'⁽ᵏ⁺¹⁾ = (1 − α) · X + α · (D⁻¹ A) · X'⁽ᵏ⁾
```

After `k` iterations, each paper's vector is its own original
SPECTER2 vector mixed with the mean of its citation neighbours
(weighted by α), then their citation neighbours of neighbours
(decreasing influence with hop distance). Output dimension is
unchanged.

Parameters:
- `alpha ∈ [0, 1]` — mixing strength per iteration. α=0 is
  identity; α=1 replaces each vector with its neighbours' mean.
  Default ~0.3.
- `iterations k ≥ 1` — diffusion depth. Each iteration moves
  information one hop. Default 4 (covers most short-path
  influence on a giant component).
- `symmetric` boolean — whether to symmetrise A first (A ∨ Aᵀ).
  Default true (direction is encoded in adjacency presence; the
  diffusion is direction-agnostic).

Cost at n=5000, d=768, |E|=12k, k=4 iterations:
`k · (|E| · d + n · d)` ≈ 4 · (12000 · 768 + 5000 · 768) ≈
50 M ops. Single-digit seconds in JS; not worker-critical.

**Where the citations come from.** This is the architectural
wrinkle:

- **Real-data path** (the load-bearing case): citations are
  imported, independent of clusters. Fusion needs them
  available at `redimred()` time, which runs *before*
  clustering. So `produceReal()` must load citation edges at
  ingest time (alongside the embedding + index) and stash them
  in `state.dataSource.citations` or a similar slot. Today's
  `imported-edges` algorithm in Layer 3 re-fetches the same
  file later; we'd repoint it at the cached data-source-side
  copy, OR keep the dual fetch (no functional harm, both are
  cheap reads of the same JSON).
- **Toy path**: citations come from `taste-network` *after*
  clustering. Fusion can't use them on the first pass. Default
  `fusion.method = "identity"` for toy keeps the cascade
  monotonic. Power-user opt-in could enable a two-pass mode
  (run pipeline once → re-run with fusion using the generated
  citations) but that's a future addition; first cut ships
  with toy fusion effectively disabled.

**Cascade behaviour.** Auto-cascade per the existing pattern:
changing fusion params triggers `redimred()` which cascades
into `recluster()` → bridge → citations → layout → blend. The
eval surface picks up fused-embedding clusters for free;
Validate / Optimise immediately work on the new representation.

**State slots added:**
- `state.layerParams.dimred.fusion = { method, params }` — slot
  config alongside `noise`, `compression`, `viz`, `viz2d`.
- `state.dataSource.citations = number[][] | null` — raw edge
  list cached at ingest time for the real-data path. Toy: null.
- `state.fusedEmbedding` (optional, for debugging) — the
  fusion stage's output buffer. Could be derived from
  `dimredResult` lineage instead; decide at implementation
  time.

**UI surface:**
- Dim-reduction modal grows a fifth section ("Fusion (citation-
  aware re-embedding)") between noise and compression. Same
  layout as the other sections: algorithm dropdown, slot-aware
  defaults, hint text, Apply.
- Workflow chart's dim-reduction node already represents Layer
  1.5 as a whole; status dot reflects fusion state alongside the
  others. No new node needed.

**Observable outputs after shipping** — what the user gets that
they don't have today:
- A new basePos (post-fusion UMAP-3) showing how the topic map
  shifts as α rises.
- New cluster labels on the fused embedding. Diff against the
  pre-fusion labels = "which papers moved cluster when
  citations were factored in."
- A quantitative answer to the "how independent are the two
  views?" question from §6.14's discussion: the magnitude of
  the cluster-label diff at α=1 vs α=0, summarised as NMI / ARI.
- The same α slider could feed bridge analysis: bridges
  between fused-embedding clusters tell you which papers are
  reorganised most by citation context.

**Smoke acceptance (toy + real):**
- Toy with fusion=identity → byte-identical pipeline output vs
  pre-§6.15 (regression test for the dimred-stage refactor).
- Real BFS-5000 with fusion=graph-diffusion (α=0.3, k=4) → new
  basePos, new cluster count probably differs from semantic-only
  baseline. Validate tab shows the new clusters have comparable
  or better stability than the pre-fusion baseline (citations
  are signal, not noise — fusion should *help* clustering).

**What this explicitly is not:**
- Not a graph neural network. Pure linear graph diffusion. No
  trained weights, no learning. Deterministic per
  `(X, A, α, k)`.
- Not a replacement for the per-frame blend. Both stay. Fusion
  modifies *what gets embedded into 3-d*; blend interpolates
  *between two 3-d arrangements*. Different things.
- Not a substitute for the algorithm comparisons in §6.14
  (Pivot MDS / spectral / Barnes-Hut). Those compete with UMAP
  on graph; fusion is a layer above them that all of them can
  consume.

### 6.5 Stability + Optimisation (Validate + Optimise) ✓ ↻ — **beta**

**Decision (2026-05-24): Validate tab to be removed.** Bootstrap-
Jaccard is now reachable from inside Optimise via the
`clusterRichnessScorer` / `stabilityScorer` paths AND via the
target-range sweep's `runBootstrap` flag, all on the
currently-selectable configs. The standalone Validate tab on the
single applied config is redundant — same engine
(`eval/bootstrap.js`), same Hennig thresholds, just one config
instead of a swept grid. Removal scoped under §6.18 below.

**Shipped as a tabbed cluster modal** — not a standalone `Validate ▾`
button. The Cluster modal opened from the workflow chart's
Clustering node currently has three tabs: **Configure / Optimise /
Validate** (Validate removal pending). Same modal frame, same
Cancel/Apply footer, same visual rhythm across tabs (notice →
settings → run → results).

**Beta status.** The Optimise surface is live and load-bearing
for current development but the interface, the scorer set, and the
result-table column choices are expected to change. Treat it as a
working prototype: file shapes (`eval/{jaccard,bootstrap,scorers,sweep}.js`)
and `state.evalResults` slots may both be rewritten before this is
considered stable. Specifically: §6.18 audit (in flight) is
expected to surface both computational and scientific changes.

Engine pieces (in `app/src/eval/`):
- `jaccard.js` — `jaccardSimilarity(setA, setB)` and
  `bestMatchJaccard(refLabels, candLabels, idMask?)`. Mask
  argument restricts the comparison to a subset of node ids so
  the bootstrap can compare reference clusters against
  subsample-only candidate clusters without unfairly penalising
  reference members that didn't get sampled.
- `bootstrap.js` — `bootstrapStability({...})` async loop. Yields
  `await new Promise(r => setTimeout(r, 0))` between iterations
  so the main thread repaints during long runs. Aborts cleanly
  via `abortSignal.aborted`. Returns per-cluster
  `{clusterId, memberCount, meanJaccard, classification}` plus
  aggregate stats. Hennig thresholds (`HENNIG_STABLE = 0.85`,
  `HENNIG_DOUBTFUL = 0.60`) exported for the UI.
- `scorers.js` — four pluggable scorers, uniform `score()`
  signature so the sweep is metric-agnostic:
  - `ariScorer(groundTruth)` — toy mode (ground truth =
    `originId`); primary = ARI.
  - `stabilityScorer({B, subsampleFrac})` — Hennig fraction-
    stable. **Documented failure mode**: ranks trivially-coarse
    clusterings highest because a single mega-cluster
    bootstraps to ~100% stable.
  - `numClustersScorer()` — primary = `nClusters`, no
    bootstrap. Useful when you trust the algorithm and want
    to push toward more clusters.
  - `clusterRichnessScorer({B, subsampleFrac})` — primary =
    `nClusters × meanJaccard`. Penalises both extremes:
    `1 × 1.0 = 1` ties with `200 × 0.005 = 1`; the sweet spot
    (e.g. `24 × 0.55 = 13.2`) wins. **Default scorer for real-
    data auto-pick** (toy stays on ARI).
- `sweep.js` — `sweepAcrossAlgorithms({...})` enumerates
  configs across `algorithms × modalSchema sweep grids`, ranks
  by scorer's primary metric. **`resolutionOnly: true`** flag
  (default ON) restricts to fields tagged `resolution: true` —
  keeps the cross-algo grid tractable (HDBSCAN's full grid
  alone is 648 configs; resolution-only trims it to 6).
  Legacy `sweepAlgorithm` shim preserved for the legacy shell.

Registry tags: `mutualKNN.mutualK`, `hdbscan.minClusterSize`,
and `connected-components.k` are all marked `resolution: true`.

UI pieces (in `app/src/ui/modals/clustering-tabs/`):
- `configure-tab.js` — extracted from the previous one-shot
  cluster modal. Exposes `getWorking()` + `overwrite()` so
  Optimise can write a config back to the editor.
- `validate-tab.js` — notice → settings (B / subsample sliders)
  → Run + Cancel buttons → in-place results: aggregate banner
  + per-cluster sortable bars + Hennig legend. Click row →
  selects that cluster in the viewer (re-uses the existing
  selection plumbing).
- `optimise-tab.js` — same vertical rhythm. Algorithm
  checkboxes, **sweep mode radio (Resolution only / Full grid /
  Target range)**, Bootstraps slider, scorer dropdown (Automatic /
  Match to known groups / Cluster richness / Number of clusters /
  Cluster reproducibility — Auto picks ARI for toy, richness
  for real). Results table **shows every config the sweep
  produced** with **sortable columns** (click any header to
  re-rank; `#` column stays fixed as the original primary-
  scorer rank). Columns adapt to the scorer: `Match` (ARI),
  `Reproducibility + Richness` (richness), `Stable %  +
  Reproducibility` (stability), or just `Clusters` (numClusters).
  Per-row Apply has a **level picker** (`L0 / L1 / … / + New
  level`) that lands the chosen config into the named slot, then
  **hops to the Validate tab** so the natural workflow is Configure
  → Optimise → Validate. Target-range adds a **Source** column when
  the sweep ran against both pre- and post-fusion dim-reductions
  (see §6.17).

Shared CSS (`.cm-tab-*`) so tabs read consistent. `Running…`
animation reused from the dim-reduction modal slice. Scrollable
tbody (max-height 320px) keeps long sweeps manageable.

Registry tag: `hdbscan.selectionMethod` is marked
`resolution: true` so resolution-only sweeps try both EOM and
Leaf (otherwise EOM wins every time as the pinned default).

Smoke-tested at toy scale (n=400):
- Validate B=25 → 24 clusters scored in ~25 s.
- Optimise resolution-only sweep → 27 configs (8 mutualKNN +
  12 HDBSCAN + 7 CC) ranked by ARI in ~15 s. Top-row Apply
  lands in Validate.
- Number-of-clusters scorer ranks CC k=1 (201 clusters) first;
  richness scorer correctly penalises that (richness =
  201 × 0.005 ≈ 1) and finds the balanced sweet spot.

### 6.18 Optimise hardening pass ✓ — complete 2026-05-25

The Optimise tab is the load-bearing surface for choosing a
clustering. Clustering choice drives every downstream conclusion
the toy makes, so the limitations of *how Optimise picks* compound
into limitations of *what the toy claims*. This slice audits the
surface, then fixes things in three passes.

**Order (locked):**
1. **Remove the redundant Validate tab.** ✓ — done 2026-05-24.
   `clustering-tabs/validate-tab.js` deleted; clustering modal
   reduced to **Configure / Optimise**; `setValidateResult` left as
   a deprecated no-op export and `state.evalResults.validate` slot
   preserved on the read side so old saves deserialise cleanly;
   topbar `Validate ▾` menu trimmed (Bootstrap-Jaccard entry
   removed; ARI dim-sweep + cluster-vs-cluster disagreement stubs
   retained as legitimate future work). Doc fix-ups in `doc/eval.md`,
   `doc/ui-architecture.md`, and `README.md`.
2. **Computational fixes — ✓ complete 2026-05-24.** Sub-items:
   - **§6.18.2 (A1 + A4) ✓ — shipped 2026-05-24.** `algo.infer`
     calls in `eval/sweep.js` (three sites: cartesian sweep, Phase 1,
     Phase 2) and `eval/bootstrap.js` (per-iter) now run inside
     `clustering-worker.js` via a new `mode: "infer"` dispatch path.
     Helper at `app/src/eval/run-infer-remote.js` centralises the
     payload shape. Bootstrap iterations fire concurrently via
     `Promise.all` — subsample sets are pre-generated up front so the
     deterministic mulberry32 walk matches the pre-parallel
     implementation byte-for-byte at the same seed (verified by
     `scratch/eval_workers_smoke.py`). Mid-flight cancellation under
     the polling `{aborted: bool}` convention is honoured pre-flight
     and during scoring; mid-flight termination of in-progress workers
     needs a real `AbortController` pass (queued under §6.18 follow-up).
   - **§6.18.3 (A2 + A3) ✓ — shipped 2026-05-24.**
     **A2:** target-range Phase 2 now consults a `phase1CrByKey` map
     (keyed by `(algoId, stableStringify(params))`) before firing each
     worker call. Phase-1 hits whose base config recurs as a Phase-2
     candidate (always — `expandNeighbours` includes the base) skip the
     infer entirely. Smoke shows ~9 of 17 Phase-2 configs reused from
     Phase-1 at toy n=400 / refineStep=2 (53% cache hit rate); at
     BFS+HDBSCAN scale each cache hit saves ~15 s of `algo.infer`.
     `phase2CacheHits` exposed on the sweep result for visibility.
     **A3:** per-row Apply now threads the swept cr through as
     `precomputedCr`. New plumbing: `runClusterLevels` accepts
     `opts.precomputedLevels[i]` (only L0 eligible — within-parent
     siblings can't be lifted from a sweep's cr); `clustering-worker.js`
     cascade mode passes it through; `engine.recluster({precomputedCr})`
     matches it against the active L0 config via a sorted-key params
     comparison and skips L0's infer when matched; `layer-descriptors.js`
     clustering descriptor's `applyChange(algoId, levels, opts)` forwards
     the option; `clustering-modal.js`'s `onApplyRow` reads `row._cr`
     and passes it. `_cr` is a runtime-only field, stripped before
     `setOptimiseResult` so persisted projects stay clean (cache loss
     across reloads is accepted — the in-session cache is what matters).
     Smoke verifies warm recluster reproduces the cached cr byte-for-byte
     and is no slower than a cold run. Tests:
     `scratch/cache_wins_smoke.py`.
   - **§6.18.4 (A6) ✓ — shipped 2026-05-24.** `optimise-tab.js`
     constructs a fresh `AbortController` per run; passes
     `controller.signal` everywhere the old polling object went.
     Downstream consumers (`sweep.js`, `bootstrap.js`,
     `runInferRemote`) didn't need API changes — `AbortSignal` is
     `.aborted`-compatible for the old polling checks and exposes
     `.addEventListener("abort", ...)` so `worker-runner.js`
     actively terminates in-flight workers when the user clicks
     Cancel (or switches tabs). Cancel + tab-hide both call
     `controller.abort()`. AbortError is filtered from
     `console.error` in both `sweep.js` and `bootstrap.js` so a
     cancel doesn't spam B log lines. Smoke: at toy n=400 + HDBSCAN
     B=20, cancellation 50 ms into the run returns in ~120 ms with
     0 iters scored (vs ~1.5–2 s under the old polling-only
     pattern). Test: `scratch/abort_cancellation_smoke.py`.
   - **§6.18.5 (A5) ✓ — shipped 2026-05-24.** Dropped the
     unconditional `setTimeout(0)` yields from
     `sweepAcrossAlgorithms`'s outer loop and `runTargetRangeSweep`'s
     Phase-1 loop — `await runInferRemote(...)` is itself a real async
     boundary so the main thread gets repaint chances naturally.
     Phase 2 keeps a yield, but conditioned on `!didAwait` — the only
     loop path with no implicit await is the cache-hit + no-bootstrap
     branch (everything's served from `phase1CrByKey` without going to
     a worker), which would otherwise tight-loop through pure JS and
     block repaints. Modest wall-time win at toy scale (~4% on a
     22-config sweep) that scales with config count. **(A7 dropped
     from scope.)** Per-iter sub-buffer reuse is structurally
     incompatible with `transferDimred: true` (transfer detaches the
     main-thread reference). The alternatives — drop transfer and
     pool one buffer (slower postMessage via structured clone), or
     move to SharedArrayBuffer (needs CORS COOP/COEP headers the
     static dev server doesn't ship) — are net negative or beyond
     scope. The current per-iter allocation + transfer is the best
     trade-off available. **(A8 deferred.)** Adaptive Phase-1 budget
     allocation across enabled algorithms is a redesign, not a
     cleanup — interleaving the Phase-1 loop changes determinism
     (sample sequence depends on early-iter outcomes). Revisit if
     real-data scale shows skewed hit distributions.
   - **§6.18.6 Busy-label lifecycle bug ✓ — fixed 2026-05-25 as part of §6.18.10.**
     When the user clicks Apply in the data-source modal, the bar
     enqueues `"Loading data…"` correctly, but `reingest()` immediately
     cascades through `redimred()` → `recluster()` → `reneighbour()`,
     each calling `setBusyLabel("Dim-reduction…" / "Clustering…" /
     "Citations…")` in turn. At toy scale the phases complete in tens
     of ms, so the user sees only the *last* label set — typically
     "Clustering…" — for the brief moment before the bar hides. The
     dim-reduction modal Apply path and the clustering modal Apply path
     each show their correct phase label because no upstream cascade
     overrides it. Likely fixes (pick one, not pre-committed):
     (a) introduce a minimum visible duration per label
     (~150–300 ms) so each phase reads;
     (b) keep the headline label set by `enqueueBusy(label, ...)` and
     show cascade phases as a *secondary* status line below the
     headline, not by overwriting;
     (c) drop the per-phase `setBusyLabel` calls inside lanes and let
     the modal own the label end-to-end. Recommend (b) since it
     preserves the headline-action contract and surfaces the per-phase
     detail. Track here; address after §6.18.5.
3. **Scientific fixes — ✓ complete 2026-05-25.** Sub-items broken
   out below (§6.18.7 → §6.18.10). Order discussed + locked with
   the user 2026-05-24: bootstrap-protocol overhaul first (touches
   every saved result; one migration); target-range refinements
   next (depends on .7 protocol); noise + edge cases;
   surface-honesty UI changes last.
   - **§6.18.7 (B1 + B2 + B3 + B4) ✓ — shipped 2026-05-24.**
     Bootstrap protocol + scoring overhaul. One coherent migration
     (`scoreVersion: 2`) covering:
     - **B1** — bootstrap protocol locked as subsampling *without*
       replacement (per Hennig 2008 §3.2). User decision: keep the
       subsampling form rather than switch to with-replacement; the
       Hennig thresholds (0.85 / 0.60) are kept as a coarse colour
       code only, not the headline number, since they were
       calibrated against with-replacement.
     - **B2** — `subsampleFrac` default 0.8 → 0.5 (Hennig 2008's
       m = n/2 recommendation; 0.8 was inflating reproducibility
       across the board because subsamples were too similar to the
       full data). Defaults updated in `bootstrap.js`, `scorers.js`
       (`stabilityScorer` + `clusterRichnessScorer`).
     - **B3** — `bestMatchJaccard` greedy → `bipartiteMatchJaccard`
       (Hungarian / Munkres). New helper `maxWeightMatch` in
       `eval/jaccard.js` (~80 LoC, classic O(n³) implementation,
       handles rectangular cases via padding). Smoke verifies
       double-counting refusal: greedy gives 2 refs both 0.5
       against a coarsened mega-candidate; bipartite forces 1 ref
       to 0.5 + the other to 0. Legacy `bestMatchJaccard` kept
       exported (marked DEPRECATED) for any external caller.
     - **B4** — `meanJaccard` split into `meanJaccard_macro`
       (size-weighted; primary) and `meanJaccard_unweighted`
       (one-cluster-one-vote). Both surfaced as columns in the
       Optimise table. `fractionStable` kept but no longer a
       primary metric — feeds a coloured Hennig breakdown bar
       (`.cm-hennig-bar` in `main.css`) so the user sees the
       stable/doubtful/unstable distribution honestly instead of a
       single number that compresses it. Backward-compat alias
       `aggregate.meanJaccard` kept (== macro) so cached results +
       the richness scorer don't break.
     - **Migration:** `setOptimiseResult` stamps `scoreVersion: 2`
       on every save. On Optimise-tab boot, caches without
       `scoreVersion === 2` are silently discarded and the user
       sees a banner: *"Older optimise scores discarded — re-run
       to see scores under the current method (§6.18.7)."*
       Discard chosen over upgrade-in-place per user call — old
       numbers and new ones genuinely mean different things.
     - Test: `scratch/scoring_v2_smoke.py` covers all three.
   - **§6.18.8 (B7 + B10 + B12) ✓ — shipped 2026-05-25.** Target-
     range refinements:
     - **B7** — hint tightened (toggle kept per user call). Off mode
       reframed in the help text as "Quick exploration — not a
       quality measure; treats every in-band config as equally good
       and just picks the one nearest the centre." On mode noted as
       the metric for "choosing a final config to commit to."
     - **B10** — bootstrap seed in `runTargetRangeSweep` derived
       from `(seed, algoId, stableStringify(params))` via the new
       `configSeed` helper. Old form `(seed ^ 0xBEEF) + i` depended
       on Phase-2 array index, so identical configs could score
       differently across runs whenever cache dedup reordered the
       walk. Smoke confirms: 18 common configs across two runs
       (different `phase1Count`, same outer seed) all scored
       identical `meanJaccard` after the fix.
     - **B12** — when `phase1.filter(inRange).length === 0`, fall
       back to the K=3 closest-to-band Phase-1 configs (distance =
       `max(0, targetMin - n, n - targetMax)`) and refine those.
       Outcome carries `usedFallback: true`; merge logic propagates
       the flag across multi-pass "Both" runs; status banner in
       optimise-tab reads "no hits in [min, max] — refined the
       closest Phase-1 configs". Smoke confirms an impossible band
       (10k–99k clusters on toy n=400) refines 3 fallback configs
       with the flag set.
     - **Bonus cleanup.** Discovered during the merge edit that
       optimise-tab.js's "both passes" path hardcoded
       `subsampleFrac: 0.8` overriding the new §6.18.7 default.
       Replaced with `bootstrapOpts: { B }` so bootstrap.js's
       0.5 default flows through.
     - Test: `scratch/target_range_refinements_smoke.py`.
   - **§6.18.9 (B8 + B9) ✓ — shipped 2026-05-25.** Noise + edge
     cases. Bumps `SCORE_VERSION` 2 → 3 because B9 changes
     per-cluster numbers (tiny clusters that previously scored 1.0
     via trivial-singleton matches now score lower or 0). Old
     caches discarded on load via the existing §6.18.7d mechanism.
     - **B9** — `bipartiteMatchJaccard` gains `opts.minMembers`
       (default 0, no filter). `bootstrap.js` passes `minMembers=3`
       per Hennig 2007 §3.2 — ref clusters with fewer than 3
       in-subsample members are dropped from that iter's scoring
       (a 1-member-in-subsample cluster vs a singleton candidate
       scored Jaccard=1.0 mechanically, which was meaningless).
       Exposed as an arg on `bootstrapStability` for future tuning.
       Smoke confirms a hand-crafted 3-cluster ref (sizes 1, 2, 7)
       produces only the size-7 cluster in the match output.
     - **B8** — `noiseHandling: "exclude" | "asCluster" |
       "penalise"` parameter, default `"exclude"` (current
       behaviour). `"asCluster"` remaps -1 in both reference and
       per-iter candidate to a synthetic `NOISE_ID` so the
       bipartite match treats noise-vs-noise as a real cluster
       pairing. `"penalise"` keeps exclude-style matching but
       scales aggregates by `(1 − noiseFraction)`; exposes
       `meanJaccard_macro_raw` + `meanJaccard_unweighted_raw` so
       the pre-penalty values stay inspectable. `aggregate.noiseFraction`
       always reported (observational). Plumbed through scorer
       factories + the Optimise settings dropdown ("Noise handling"
       row with per-mode explanation in the hint). UI also records
       the chosen mode in `settings.noiseHandling` so cached results
       carry the assumption that produced them.
     - Smoke (`scratch/noise_and_min_members_smoke.py`):
       - 25%-noise reference → noiseFraction=0.250 reported
       - asCluster mode adds the synthetic NOISE cluster (nClusters
         grows by 1)
       - penalise: `macro = raw × 0.75` exactly
   - **§6.18.10 (B5 + B6 + B11 + §6.18.6) ✓ — shipped 2026-05-25.**
     Surface honesty + busy-bar. All additive UI changes; no
     migration.
     - **B5** — `computeBayesOptimalAri` in `eval/bayes-ari.js`.
       Computes the diagonal-Gaussian posterior `P(c|x)` per point,
       takes argmax for the Bayes-optimal labelling, then
       `adjustedRandIndex(bayesLabels, originIds)`. Uses empirical
       priors (observed counts / N) so the ceiling reflects this
       specific sample, not the limit. `datasource/toy.js` calls it
       at generation time; `genResult.bayesOptimalAri` is the result.
       `ariScorer` surfaces it on each row as `extra.ariCeiling`;
       the Optimise table's ARI column renders "0.85 (92% of 0.92)"
       so the user reads achieved ARI as a fraction of optimal.
       Smoke confirms: ceiling=1.0 at well-separated defaults
       (ARI=1 was achievable; the algorithm hit 0.93); ceiling=0.62
       at widened spread=3.0 (overlap forced).
     - **B6** — `formatDistributionStats(ranked)` in optimise-tab.js.
       Appends `· best X · median Y · sd Z · n N` to the post-sweep
       status line. Honest disclosure that the top score is
       cherry-picked from a sweep; spread tells the user how big
       the cherry-picking effect is. Skips when N < 2 (stats not
       meaningful). Smoke verified: 22-config sweep shows
       `best 0.992 · median 0.669 · sd 0.349 · n 29`.
     - **B11** — scorer dropdown rebuilt dynamically per
       `state.dataSource.mode`. Toy mode keeps Auto (defaults to
       ARI since ground truth exists); real mode omits Auto
       entirely. Hint reframed: "we don't auto-pick because each
       scorer answers a different question; pick the one matching
       your research aim." "Cluster richness" relabelled "Cluster
       count × reproducibility" so the trade-off is in the label.
       Optimise tab subscribes to state so toggling toy ↔ real
       refreshes the dropdown without re-opening the modal.
     - **§6.18.6** — `state.busy.current` grows a `phase` field.
       New `setBusyPhase(phase)` action in `busy.js`; engine cascade
       (5 lanes: reingest / redimred / recluster / reneighbour /
       relayoutCitations) switched from `setBusyLabel` to
       `setBusyPhase`. Busy bar renders `label` as headline +
       `phase` as a subdued secondary line beneath
       (`#busy-bar .busy-phase` CSS). Resolves the bug observed
       2026-05-24: dataset load no longer shows just "Clustering…"
       — user sees the headline they triggered ("Loading data…")
       with current cascade phase as a faded subline.
     - Test: `scratch/surface_honesty_smoke.py`.

**Out of scope for this slice:**
- Adding new clustering algorithms (separate work; algorithm
  selection is upstream of the eval surface).
- Rewriting the multi-level cascade for granular re-runs (§6.1
  follow-up; would be nice but Optimise is single-level today).
- Cross-algorithm disagreement metrics (open question in §7;
  unlocks once §6.11 Slice 5 makes pairwise re-runs cheap).

**Defensibility framing:** the user's concern is that clustering
methods are very important to results, and small limitations stack.
The endpoint of this slice is being able to point at the Optimise
output and say *"this is the best config of those I considered,
under metric M, with stability quantified by bootstrap protocol
P, on data D; here are the assumptions M and P make and how they
might fail."* — not "Optimise said this one was best."

### 6.19 Validation runs as first-class entities ☐ — added 2026-05-25, expanded 2026-05-25

Validation, sweeping, and other analytical results currently live in
three awkward places:
- **Inside a modal** (Optimise sweep table is buried in
  `clustering-modal.js → Optimise tab`; closing the modal hides it).
- **In a single-slot state field** (`state.evalResults.optimise` —
  one slot, overwritten on the next sweep, no history).
- **In a static doc file** (§6.9 dim-sweep results live in
  `doc/dim-sweep-results.md`, produced by a scratch script; not part
  of any specific project's state at all).

The reframe (user call 2026-05-25): treat every sweep / validation /
analytical run as a **first-class persistent entity** the user can
save, browse, and re-open. Each dataset is unique enough that
validation has to be re-done per fixture; building up a history of
"what was checked on this project, when, with what conclusion" is
genuinely useful — both for the user reviewing their own work and
for handing the project to a collaborator.

#### The core data shape

```ts
state.validationRuns: ValidationRun[]

type ValidationRun = {
  id:           string,              // uid for panel binding
  type:         "optimise" | "dimSweep" | "bootstrapStability" |
                "targetRange" | "alignmentSweep" | ...
  label:        string,              // user-set or auto-generated
                                      // e.g. "HDBSCAN dim-sweep — BFS-5000"
  timestamp:    string,              // ISO datetime saved
  inputs: {                           // snapshot at time-of-run
    dataSourceId: string,             // "real" / "toy"
    dataSourceConfig: object,         // subset, seed, etc.
    layerParamsSnapshot: object,      // what dim/fusion/etc. were active
  },
  settings:     object,              // type-specific knobs (B, frac, dims, etc.)
  results:      object,              // type-specific results (see below)
  scoreVersion: int,                 // SCORE_VERSION at time of run
  runtimeSec:   number,              // wall time it took
}
```

Per-type `results` shapes (sketches; finalise as each runner moves
into this scheme):
- `"optimise"`: the `ranked` rows + `aggregate.*` + scorer id. Same
  shape as today's `state.evalResults.optimise`.
- `"dimSweep"`: ARI matrix + cluster counts + verdict, as written
  to `doc/dim-sweep-results.md` today.
- `"bootstrapStability"`: per-cluster Jaccard bars + Hennig
  breakdown for a single applied config.
- `"targetRange"`: phase1 + phase2 + ranked + fallback flag.
- `"alignmentSweep"` (future): citation-layout algorithm vs
  alignment correlation, per `relayoutCitations()` algo choice.

#### The UX flow

1. **Save-this-run button.** Each surface that produces a sweep
   result gets a "Save this run" affordance after the run completes
   (Optimise tab footer, eventual Dim-sweep modal footer, eventual
   Bootstrap-stability panel). Opt-in — not every exploration needs
   archiving. Asks for an optional label; auto-generates one if blank.
   Stamps the run into `state.validationRuns` with current timestamp.
2. **Panel-picker integration.** The `+ Add panel` modal grows a
   "Validation runs" category. Each stored run lists as a panel
   option ("HDBSCAN dim-sweep — BFS-5000 — 2026-05-25"). Picking one
   opens the appropriate renderer panel (table for tabular, heatmap
   for matrix-like, etc.) bound to that run's id. Same run can be
   pinned in multiple panels (compare side-by-side) and survives
   tab hops.
3. **Persisted with the project.** `validationRuns` rides along in
   the `.zip` save (existing `persistence/serialise.js` patterns +
   the existing schema-version mechanism handles it). Loading a
   project reads the runs straight back; their panels can re-pin
   themselves.
4. **Resource without recalculating** (the big-payoff use case). A
   saved Optimise sweep carries every row's params. Picking a
   non-top row from the saved sweep + clicking "Apply" re-applies
   that single config — at worst a single `algo.infer` call, vs the
   original N-config sweep (could be 10 minutes of HDBSCAN at
   BFS-5000). Open question: do we also persist the per-row `_cr`
   (Int32Arrays) so even the single infer is skipped (the §6.18.3
   `precomputedCr` path works)? Trade-off: faster reapply vs larger
   save files (~20 KB per row × N rows). Lean: persist cr for
   sweeps that took > 30 s to run; skip for the rest. Decide at
   implementation time.

#### Panel-type renderers (the original §6.19 list, reframed)

Each is a *renderer for a ValidationRun of type X*, not a one-off
panel hooked to a one-off state slot:

- **Optimise results panel** — renders a `type: "optimise"` run.
  Same sortable table the Optimise tab uses. Per-row Apply still
  works (with cr cache when available).
- **Dim-sweep results panel** — renders a `type: "dimSweep"` run.
  ARI matrix as a heatmap + cluster-count bar plot + verdict
  banner. Heatmap uses the existing `gradients.js` for colour
  bars; no chart library dependency.
- **Bootstrap stability panel** — renders a
  `type: "bootstrapStability"` run. Per-cluster Jaccard bars +
  coloured Hennig breakdown + aggregate macro / unweighted /
  noiseFraction.
- **Target-range panel** — renders `type: "targetRange"`. Same
  table the Optimise tab uses for target-range mode, plus the
  hits-in-band callout.
- **Method receipt panel** — derived view, not a saved run.
  Assembles the §6.18 defensibility paragraph from the *currently
  active* state. Could also bind to a specific saved run to show
  "the recipe that produced this run".
- **Bridge analysis panel** — `bridgeAnalysis.perCluster` table.
  Not a ValidationRun (bridge is always-on derived state); just a
  panel renderer for the existing data.
- **Fusion comparison panel** — when fusion is non-identity:
  ARI(preFusion, postFusion), cluster-switch count, biggest
  movers. Currently derivable from existing state; eventually a
  `type: "fusionComparison"` run that records the snapshot.

#### Charts / plots — pick a strategy, not a library

Two visualisations land in the first batch:
- **Heatmap** for the dim-sweep ARI matrix (and any other
  pairwise matrix that emerges).
- **Histogram / bar plot** for cluster-size distributions and
  swept-score distributions.

Lean **tiny SVG-from-scratch helpers** rather than a chart library:
- Dependency size matters (the toy is a static page); avoid
  adding a 200 KB d3 / Plotly dep.
- The shapes we need are simple (rectangles for heatmap cells,
  bars, lines). Code is ~100 LoC per chart type.
- We already have `gradients.js` for colour scales; extend it
  with `heatmapCell(value, palette)` + axis-tick helpers.

#### Schema migration

Adding `state.validationRuns` is additive; old saves without the
field load fine (empty list). When per-type `results` shapes evolve
(or `scoreVersion` for bootstrap-type runs bumps), the
`scoreVersion` field on each run lets the loader decide per-run
whether to keep, drop, or upgrade. Same migration pattern as
§6.18.7d.

#### Open design questions

- **Save-with-cr vs strip-cr.** For Optimise + target-range runs,
  whether to persist the per-row `cr` Int32Arrays. Touched above;
  decide per-type at implementation time.
- **Project-portability vs project-specific.** A run carries an
  inputs snapshot. If the user loads a saved project then loads
  another project that has saved runs, do they import? Lean: runs
  belong to the project they were saved in; loading another
  project loads only its runs. No cross-project import yet.
- **Run cap.** Should we cap `validationRuns.length` to prevent
  saves growing unbounded? Lean: no cap, but show a "manage runs"
  surface in the Validation-history panel so the user can delete
  individual runs.

#### Order to land in

1. **State shape + persistence ✓ — shipped 2026-05-25.**
   `state.validationRuns: ValidationRun[]` slot with typed actions
   (`saveValidationRun` / `deleteValidationRun` /
   `clearValidationRuns` in `app/src/ui/state.js`). Persistence
   plumbing in `app/src/persistence/serialise.js` — added a
   generic `stashBinariesIn` deep-walker that replaces any
   TypedArray anywhere in a run's nested `results` with a
   `{__binary, type, length}` descriptor. The deserialiser's
   `reviveBinaries` walker is already generic, so the round trip
   closes automatically. **Additive schema** — older saves with
   no `validationRuns` key load cleanly (state default `[]` kicks
   in). Smoke: `scratch/validation_runs_persistence_smoke.py`
   verifies the default, all three typed actions, bad-input
   rejection, full round-trip with an Int32Array buried in
   `results.partition`, and the legacy-save case.
2. **Save-this-run + panel-picker integration ✓ — shipped 2026-05-25.**
   First end-to-end use of `validationRuns`. Wired Optimise as
   the proof-of-concept; the same pattern extends to dim-sweep /
   bootstrap-stability / etc. once their renderers register.

   - **Renderer extraction.** Moved `renderResults` + scorer column
     logic + cell formatters from `optimise-tab.js` into a new
     `optimise-results-renderer.js` so the saved-run panel can
     share the renderer without coupling to the modal. ~280 LoC
     extracted; modal still uses the same code path.
   - **Save-this-run button.** Appears in the Optimise run-row
     after a successful sweep. Click → `window.prompt` for a label
     (auto-suggested from sweep settings + data fixture + date) →
     `saveValidationRun({ type: "optimise", ... })`. Persists the
     same `persistedRanked` rows that `setOptimiseResult` already
     uses, so saves are compact (no per-row `_cr` Int32Arrays in
     v1). Per-row Apply on a reload re-infers (cheap relative to
     the original sweep).
   - **Panel picker.** Now lists two sections — *Panel types*
     (the previous list, minus singletons-already-mounted) and
     *Validation runs* (every saved run, sorted newest-first).
     Picking a saved run injects `config = { runId }` so the
     new panel binds to that specific run.
   - **`validation-run-optimise` panel.** New panel in
     `app/src/ui/panels/`. Reads its run by `config.runId` from
     `state.validationRuns`; renders the saved table via
     `renderResults`. Per-row Apply routes through the clustering
     descriptor (same path as the modal Apply). Header shows
     label + meta (config count, scorer, fixture, save time);
     warns if the current `dataSource.mode` differs from the
     saved run's. Panel is marked `HIDE_FROM_TYPE_LIST` so it
     never appears as a "blank" panel choice — only as a
     bound-to-a-runId entry under "Validation runs".
   - **panel-system.js** — `openPanelPickerModal` callback
     extended to accept `(typeId, config)`; merged over the
     default-config-for-type so type-level defaults still apply.

   Smoke (`scratch/save_run_and_panel_smoke.py`, toy n=400):
   sweep → Save → state.validationRuns grows → picker lists the
   run under "Validation runs" → panel mounts bound to runId →
   29 sortable rows with Apply buttons → clicking Apply on a row
   re-clusters with the chosen config (mutualK=5 → k=20 verified).
   Zero console errors. All five pre-existing smokes still pass.

   **Known limitation (carried to step 5+):** v1 strips `_cr`
   from saved rows because the in-modal Optimise tab also strips
   before persisting via `setOptimiseResult` (and we reuse that
   `persistedRanked` shape for parity). Per-row Apply on a saved
   run re-infers; the sweep itself doesn't re-run. "Persist with
   cr" is the §6.19 follow-up that makes Apply instant.
3. **Optimise results panel** — biggest immediate user win; uses
   the §6.18.3 cr cache for instant reapply on saved rows.
4. **Dim-sweep results panel** — depends on §6.9 promoting from
   scratch script to in-app surface. ARI heatmap renderer.
5. **Bootstrap stability panel** — needs a "Run" button + progress
   surface inside the panel (separate from the engine cascade).
6. **Method receipt panel** — small; once §6.18 is done it's just
   assembling the paragraph from active state or a bound run.
7. **Bridge analysis panel** — lift existing node-table renderer
   into a standalone panel.
8. **Fusion comparison panel** — depends on better cross-view
   metrics (currently fusion changes are qualitative).

The two highest-payoff use cases (per user 2026-05-25):
- **Saved Optimise sweep**: 10-minute HDBSCAN × full-grid sweep on
  BFS-5000 becomes a permanent artifact. User can revisit the
  table next week and try a different config from the same sweep
  without re-running.
- **Saved dim-sweep**: per-project ARI validation that travels
  with the project archive — anyone opening it sees the empirical
  evidence behind the chosen compression dim.

### 6.6 Save / load project state ✓
Project state persists to a `.zip` archive the user explicitly
saves and loads via the topbar `File ▾` menu (Save / Save as… /
Load…). Reloading a project restores the dim-reduction →
clustering → bridge-analysis → eval-results cascade verbatim;
the engine cascade is intentionally *not* triggered on load
(we have the results already; re-running would overwrite them
and defeat the point of saving).

Format (`app/src/persistence/`):
- `manifest.json` — `schemaVersion`, `appName`, `appVersion`,
  `savedAt`, `projectName`, contents inventory.
- `state.json` — JSON-serialisable state with binary descriptors
  (`{__binary, type, length}`) replacing TypedArrays.
- `arrays/*.{f32,i32,u8}` — raw TypedArray payloads (basePos,
  embedding, dimredResult, per-level nodeCluster + noiseFlags,
  bridge perNodeScore + perNodeIsBridge, citation layouts).

Slots saved:
- dataSource (mode + per-mode configs), layerParams,
  activeAlgorithm, layerStates, panels, selection, blend,
  bridgeConfig
- genResult (nodes + origins inlined as JSON; per-node basePos
  arrays small enough to inline)
- _basePos, embedding, dimredResult, clusterLevels,
  bridgeAnalysis, neighbourhoodResult, tasteResult,
  citationResult, citationLayout, alignedCitationLayout,
  alignmentCorrelation
- evalResults (validate + optimise — backed by new state slots
  the eval tabs write into; survive tab hops + project saves)
- projectName

Slots excluded: engineRevision (counter, meaningless across
sessions). clusterResult is omitted because it's an alias for
the finest level — restored from clusterLevels on load.

**Schema version**: SCHEMA_VERSION currently = 2 (bumped from 1
in §6.7 when `_basePos2d` joined the saved state). Loader refuses
on mismatch (per the user's strict-refusal choice). Bump in the
same commit as any state-shape change.

**Engine integration**: `recluster()` clears `evalResults` so
stale Validate / Optimise scores don't survive a clustering
config change.

Smoke-tested at toy scale: save → reload page → load → state
matches byte-identically (basePos `[34.945, -16.763, 33.898]`
restored exactly, 24 clusters preserved, mutualKNN method, etc.).

### 6.7 2D viewer panel ✓
Canvas-based 2D viewer mounted alongside the existing 3D viewer.
Reads `state._basePos2d`; renders an empty-state hint until the
user picks a 2-d viz reduction in Layer 1.5.

Architectural change: Layer 1.5 grew a **fourth sibling sub-stage**:

```
embedding ─▶ noise ─┬─▶ compression ──▶ dimredResult (clustering)
                    │
                    ├─▶ viz          ──▶ _basePos     (3D viewer / blend)
                    │
                    └─▶ viz2d        ──▶ _basePos2d   (2D viewer)
```

`viz` and `viz2d` are independent fits with distinct random seeds
(43 and 44) so re-running one doesn't disturb the other.

What landed:
- `app/src/ui/viewer-shared/colour-modes.js` — extracted from
  viewer-3d. `getColourModeOptions`, `clusterResultForMode`,
  `baseColourFor`, `nodeMatchesSelection`, `nodeColourFor`. Both
  viewers delegate `nodeColour` to the shared resolver — every
  colour mode + selection-dim rule works identically across them.
  viewer-3d's previous inline implementation is now a 1-line
  delegation.
- `app/src/ui/panels/viewer-2d.js` — uses `force-graph` (canvas-
  based 2D companion to 3d-force-graph) loaded via importmap
  (`https://esm.sh/force-graph@1.43.0`). Pins node positions via
  `fx/fy`; no link rendering; same colour-mode dropdown widget
  as viewer-3d for visual parity. Empty-state hint when
  `state._basePos2d` is null.
- `state._basePos2d` (Float32Array(n*2)) + `state.layerParams.
  dimred.viz2d` slot + UMAP's `family: ["compression", "viz",
  "viz2d"]` tag + slot-aware default `n_components=2,
  n_neighbors=15, min_dist=0.1, random_state=44`.
- Engine `redimred()` runs all four sub-stages; viz2d output is
  centred + isotropically scaled via `normaliseToViewerScale2d`
  (target RMS 90, same as 3D for visual parity) before being
  adopted as `_basePos2d`.
- Dim-reduction modal grew a 4th section ("2D visualisation
  reduction").
- Save/load: `SCHEMA_VERSION` bumped 1 → 2; `_basePos2d` added
  to serialise / deserialise. Old v1 files refuse to load.

**Panel-system fix (incidental)**: the slice surfaced a recursion
bug — a panel's `mount()` writing to `state.panels` (via the
colour-mode migration calling `setTabConfig`) re-entered
`renderActivePanel` mid-mount, leaving orphan DOM overlays. Fix:
pre-register `slotInstances` with the new tab id BEFORE calling
`mount`, so the re-entrant subscribe sees `tracked.tabId ===
desired.activeTabId` and skips remounting. Same fix protects
viewer-3d from the same failure mode.

### 6.8 Real-data pipeline ports — **deferred indefinitely**
Was items 5–7 in the original plan. **Explicitly deferred (2026-05-24).**
Per user call: the Python scoring-app integration is not critical
to the toy's value — it's something to do *once the analysis is
near perfect with minimal scientific limitations*, not part of the
current focus. The toy keeps shipping as the load-bearing surface;
ports are revisited only after §6.5 / §6.17 (optimisation) reach
a defensible scientific footing.

For posterity:
- Layer 4 (citation layout) — pivot MDS per Leiden component, in
  Python.
- Layer 5a (alignment) — `blend/align.js` ported to Python;
  runs on real-pipeline outputs.
- Layer 5b (per-frame blend) — α slider in scoring app; plotly
  scattergl repaints.

### 6.9 ARI dim-sweep validation ✓ — complete 2026-05-25

Was item 4 (and §2.5). Run the same clustering at UMAP target dim
∈ {30, 50, 100, 200}, ARI between resulting partitions, threshold
check `ARI(50, 100) > 0.9` for 50-d defensibility.

**Verdict: FAIL — bump compression default 50 → 100.**

- `mean ARI(50, 100) = 0.806 ± 0.063` across 3 seeds (42, 43, 44)
  on the BFS-5000 fixture with HDBSCAN at `min_cluster_size=15,
  min_samples=5` (the locked `min_cluster_size=100` produced
  2-cluster degenerate partitions at n=5000, so the sweep was
  re-run at the n=5000-appropriate value to keep the ARI signal
  meaningful).
- **Notable secondary finding:** `ARI(100, 200) = 1.000 ± 0.000`
  exactly — at d=100 and d=200, HDBSCAN recovers byte-identical
  partitions across all three seeds. Past d=100 the embedding
  adds no clustering-relevant information on this fixture. So
  the new default is **100**, not "as high as possible".

**Changes shipped:**
- `app/src/dimred/registry.js` — UMAP `defaultParamsForSlot("compression")`
  now returns `n_components=100` (was 50); `n_components` max raised
  to 200; sweepValues + hint updated.
- §3.3 locked default config table updated.
- `doc/dimred.md`, `doc/fusion.md`, `README.md` — stale "UMAP-50"
  references replaced with UMAP-100 + brief rationale.
- `doc/dim-sweep-results.md` — new file; full results table +
  protocol + limitations.

**Script:** `validation/dim_sweep_validation.py`. ~17 minutes wall
on this fixture. Re-run when a new real-data fixture (or a new
clustering algorithm) lands — the verdict may not transfer.

**Limitations carried forward** (from `dim-sweep-results.md`):
- Single fixture (BFS-5000) and single algorithm (HDBSCAN). Per-
  algorithm sensitivity to compression dim could differ; Leiden /
  spectral may have a different saturation point.
- Single `min_cluster_size`. Coarser / finer clustering granularity
  may show different ARI patterns.
- ARI compares labels only; cluster *shape* could drift inside the
  ARI tolerance.

**§6.9 follow-up — is UMAP after PCA redundant?** ✓ resolved 2026-05-25.
User observation: PCA-100 noise stage already takes us to 100-d;
if UMAP compression then outputs 100-d too, is it redundant?
Tested via `validation/compression_redundancy_check.py`:

- `identity (PCA-100 → HDBSCAN)` produced **2 clusters** —
  pathological mega-cluster collapse. HDBSCAN couldn't find density
  structure in the PCA-only geometry.
- `UMAP-100 → HDBSCAN` produced **54-59 clusters** across seeds.
- `mean ARI(identity, UMAP-100) = 0.002 ± 0.000` — essentially
  zero. The two partitions are independent of each other; the
  UMAP manifold reshape is doing 100% of the cluster-discovery
  work that HDBSCAN then operates on.

**Verdict:** UMAP-after-PCA is **not redundant** — it's load-
bearing. PCA-100 is a denoiser that strips noise variance in the
input space; UMAP-100 then rearranges the manifold so Euclidean
distance becomes a useful similarity measure for density-based
clustering. Both stages do essential, distinct work. This matches
the literature in `doc/clustering-research.md` §2.2: "PCA alone
fails for HDBSCAN on transformer embeddings (GDELT result)."

**Bonus methodological finding** (worth flagging for future tests):
`ARI(UMAP_seed_i, UMAP_seed_j) ≈ 0.68–0.81` — UMAP-100 has ~30%
seed variance across independent runs at the same target dim.
This wasn't measured in the original dim-sweep (which compared
same-seed across dims) but is real and significant. Implications:
- The compression default is well-defined (UMAP-100), but the
  *resulting partition* will vary across re-runs even at fixed
  params unless `random_state` is also fixed.
- Optimise / Validate runs that quote a single ARI to ground
  truth should consider averaging across UMAP seeds, not just
  across bootstrap iterations.
- §6.18's bootstrap evaluates clustering stability under data
  subsampling; it does NOT capture UMAP-induced partition
  variance. A "UMAP-seed stability" check (orthogonal to bootstrap)
  would be a useful addition under §6.19's validation-runs scheme.

**HDBSCAN bug fix discovered + shipped during this follow-up.**
The pilot identity-mode run blew the JS call stack at n=5000
because `clustering-hdbscan.js`'s recursive `visit()` walked a
degenerate (long-chain) condensed tree — the kind density-
unfriendly inputs like raw PCA produce. Converted to iterative
with an explicit worklist + manual tail-call elision for the
single-side-persists case. Unblocks HDBSCAN on any input that
produces a degenerate tree, not just this test.

Append in `doc/dim-sweep-results.md` documents the full result.

### 6.10 `doc/method-manual.md` ☐
Was item 9. Still too early.

### Parallel track (deferred)

Compression / subsampling for "real data in the toy" — load a
~10 k subsample of the 810 k corpus into the toy for interactive
exploration. Out of scope for the immediate plan.

---

## 7. Open questions to resolve as we go

### Resolved

- ~~**Hierarchical contract precise shape.**~~ Resolved by going
  with a flat `state.clusterLevels` array of ordinary
  `ClusterResult`s — no contract extension needed. See §2.2.
- ~~**Per-level algorithm choice.**~~ Deferred (single algorithm
  across levels per user's call). Revisit if a use case appears.
- ~~**Boundary-score definition** for §6.3 bridge analysis.~~
  Picked `boundaryScore = 1 − dominantFraction` at the chosen
  `(fineLevel, coarseLevel)` pair. Of the three candidates
  (entropy / `1 − max(share)` / distinct-coarse count), this one
  is bounded `[0, 1)`, monotone in the minority share, and reads
  cleanly as a colour gradient. Entropy was the runner-up;
  distinct-coarse count is too coarse for per-node colour.

### Still open (need data or judgment)

- **Stopping predicate for recursion.** Currently the user
  controls level count manually via the modal's `+ Add level`.
  At real-data scale we may want an auto-stop: leaf-size threshold,
  coherence threshold, or modularity-gain. Not urgent at toy scale.
- **Subsample size for the toy at real-data shape.** 5 k? 10 k?
  20 k? Empirical, deferred to large-data compression work.
- ~~**ARI dim-sweep verdict.**~~ Resolved 2026-05-25 (§6.9):
  `ARI(50, 100) = 0.806` on BFS-5000 — below 0.9, so default
  bumped 50 → 100. `ARI(100, 200) = 1.000` so 100 is the
  saturation point.
- **`min_cluster_size` for HDBSCAN at 810 k.** 100 is a defensible
  starting point (≈ 0.01% of n); the cluster-sweep eval will
  refine on real data.
- **Quantitative cross-algorithm disagreement metric.** Currently
  qualitative (eyeball the legend vs colouring). When it becomes a
  workflow step, decide between ARI per-pair, AMI, or per-paper
  agreement count.
