# Plan — converging the toy and the real pipeline

**Status:** in-flight. Decisions below are committed; the
sequencing in §6 has been substantially revised to reflect what's
actually been built. Pairs with `doc/clustering-research.md` for
the research that justifies the picks.

**Current state (2026-05-12):** the toy has been substantially
re-shelled with a new UI architecture (workflow chart + multi-tab
panels + modal infrastructure) that wasn't itemised in the
original plan but turned out to be the prerequisite for almost
everything else. Multi-level clustering with global / within-parent
scope is live. Mode-aware "node table" legend follows whatever's
colouring the 3D viewer. Selection is generalised across cluster /
origin / node types. `connected-components` is the first new
algorithm registered. Validate + Optimise (cluster modal tabs) are
**beta** — interface and scorer set will change.

**Recently landed:** bridge analysis (multi-scale boundary
detection between any two cluster levels, with per-coarser-level
share breakdowns surfacing in the bridge / boundary-score node-
table sources). Layer 1.5 dim-reduction shell — registry +
contract + four-stage engine lane (noise → compression sibling
viz sibling viz2d), modal with four stacked sections, family-
tagged algorithms.
`identity` (any slot), `pca` (noise), `umap` (compression + viz)
all real and shipping via umap-js loaded over the importmap.
Layer 1 data-source registry with `toy` (Gaussian generator) and
`real` (SPECTER2 dev subset) entries; source selection lives in
a **Data card → modal** opened from the workflow chart (data panel
is the inline status surface for the active source, no longer a
switcher). Reingest is mode-agnostic. Real-data ingest path
lazy-renders — viewer stays empty until the user picks a 3-d viz
reduction, falling out for free from the dim-reduction contract
(identity on a 768-d embedding can't produce a 3-d basePos).
1000-paper SPECTER2 dev subset carved at
`literture-network/artifacts/dev_subset/` for development.

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
port; real-pipeline-only candidate), real-data citation source
(toy's taste-network is bypassed under real mode; eventual import
of the citation graph from `literture-network/` is on the list),
real-pipeline Python port (Layer 4/5a in scoring app), method
manual, IndexedDB autosave (file save/load shipped; auto-restore-
last-session is a follow-up).

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

### 2.1 New stage: dim-reduction (Layer 1.5) — **shipped**

A pluggable dim-reduction stage between Layer 1 (data source) and
Layer 2 (clustering), same registry pattern as every other layer.

**Four stages**, sibling fork between compression / viz / viz2d:

```
embedding ─▶ noise ─┬─▶ compression ──▶ dimredResult (clustering input, e.g. UMAP-50)
                    │
                    ├─▶ viz         ──▶ _basePos     (3D viewer / blend, UMAP-3)
                    │
                    └─▶ viz2d       ──▶ _basePos2d   (2D viewer, UMAP-2)
```

Compression, viz, and viz2d all read the noise stage's output (so
PCA's denoising benefits all three) but otherwise run independent
UMAP fits with independent params + seeds — clustering and the
two viewers stay decoupled. Topology computed in topology space;
viewers render by attaching node metadata, so re-running any of
the viz stages never moves cluster IDs and re-running clustering
never moves dots.

state shape:
```js
state.layerParams.dimred = {
  noise:       { method, params },
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

3. UMAP → 50 components for clustering
   n_neighbors=50, min_dist=0, init='pca', metric='cosine',
   random_state=42, low_memory=True

4. HDBSCAN on UMAP-50 output
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
| **Modal infrastructure** | `modals/modal.js` (generic dialog), `modals/algorithm-modal.js` (single-level layer config — used for citation layout), `modals/clustering-modal.js` (**tabbed**: Configure / Optimise / Validate — the only modal with internal tabs today; tab strip styled to match the panel-system tab bar), `modals/dimred-modal.js` (four-stage — noise / compression / viz (3D) / viz2d (2D) sections, slot-filtered dropdowns), `modals/data-source-modal.js` (data-source registry picker + per-source params, opened from the workflow-chart Data card), `modals/panel-picker.js`. All modals show a `Running…` progress indicator on Apply for async work. |
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

### 6.4c Real citation-edge carving ◐ (script landed; JS importer pending)

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
Enough to validate the pipeline end-to-end; a connectivity-aware
subset is the follow-up.

Sibling slices pending (next):
- `app/src/citations/importers/{registry,json-file}.js` —
  pluggable edge-import transports (file today, SQL/REST later).
  Each importer is just `fetch({dataSourceParams}) → Promise<[[src,dst], …]>`.
- `app/src/citations/imported-edges.js` — Layer 3 algorithm
  that consumes an importer and emits a `CitationResult`. Swaps
  direction (DB inbound → toy outbound) at materialisation.
- `citations/registry.js` entries grow declarative
  `needsNeighbourhoods` / `needsBasePos` flags; `engine.reneighbour()`
  consults them instead of the current `_basePos == null` hack
  (which was always a stand-in for "this algorithm needs basePos").

### 6.5 Stability + Optimisation (Validate + Optimise) ✓ ↻ — **beta**
**Shipped as a tabbed cluster modal** — not a standalone `Validate ▾`
button. The Cluster modal opened from the workflow chart's
Clustering node now has three tabs: **Configure / Optimise /
Validate**. Same modal frame, same Cancel/Apply footer, same
visual rhythm across tabs (notice → settings → run → results).

**Beta status.** The Validate + Optimise surface is live and
load-bearing for current development but the interface, the
scorer set, and the result-table column choices are expected to
change. Treat it as a working prototype: file shapes
(`eval/{jaccard,bootstrap,scorers,sweep}.js`) and `state.evalResults`
slots may both be rewritten before this is considered stable.

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
  checkboxes, **sweep depth radio (Resolution only / Full grid)**,
  Bootstraps slider, scorer dropdown (Automatic / Match to
  known groups / Cluster richness / Number of clusters /
  Cluster reproducibility — Auto picks ARI for toy, richness
  for real). Results table **shows every config the sweep
  produced** with **sortable columns** (click any header to
  re-rank; `#` column stays fixed as the original primary-
  scorer rank). Columns adapt to the scorer: `Match` (ARI),
  `Reproducibility + Richness` (richness), `Stable %  +
  Reproducibility` (stability), or just `Clusters` (numClusters).
  Per-row Apply commits the chosen config and **hops to the
  Validate tab** so the natural workflow is Configure →
  Optimise → Validate.

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

### 6.8 Real-data pipeline ports ☐
Was items 5–7 in the original plan. Pending until the toy work
stabilises.
- Layer 4 (citation layout) — pivot MDS per Leiden component, in
  Python.
- Layer 5a (alignment) — `blend/align.js` ported to Python;
  runs on real-pipeline outputs.
- Layer 5b (per-frame blend) — α slider in scoring app; plotly
  scattergl repaints.

### 6.9 ARI dim-sweep validation ☐
Was item 4 (and §2.5). Depends on dim-reduction (6.4) being live.
Run the same clustering at UMAP target dim ∈ {30, 50, 100, 200},
ARI between resulting partitions, threshold check.

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
- **ARI dim-sweep verdict.** If `ARI(50, 100) < 0.9` on real data,
  bump default to 100-d. Currently 50-d is a defensible starting
  point. Resolved when 6.4 + 6.7 land.
- **`min_cluster_size` for HDBSCAN at 810 k.** 100 is a defensible
  starting point (≈ 0.01% of n); the cluster-sweep eval will
  refine on real data.
- **Quantitative cross-algorithm disagreement metric.** Currently
  qualitative (eyeball the legend vs colouring). When it becomes a
  workflow step, decide between ARI per-pair, AMI, or per-paper
  agreement count.
