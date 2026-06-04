# Plan — converging the toy and the real pipeline

**Single plan/roadmap doc.** Current status, what's shipped, and
what's next live in **§0** below. Per-layer contracts + algorithms
live in the reference docs (`doc/dynamics.md` is their index). The
shipped sequencing log (§6) is condensed to one line per item — full
detail is in the per-layer docs + git history.

## 0. Roadmap & status (consolidated 2026-05-30)

This file is the **single plan/roadmap doc**. The two former standalone
plans were folded in here on 2026-05-30:

- the **workflow-tree redesign** (Phase 2) → now §8, **shipped**;
- the **multi-level clustering + tree scoring + bridge clusters** plan →
  now §9, **shipped 2026-05-31** (MLC-0 → MLC-5).
- the **card palette consolidation** (cards.md) → now §10, **shipped
  2026-06-03**. Bridge + bootstrap moved from standalone cards into the
  layers that consume them; per-pair bridge heatmap added to the picker;
  auto-spawn of analysis cards; per-card-type panel slot routing.

Per-layer reference docs stay separate (`doc/dynamics.md` is their
index): clustering, dimred, fusion, citations, citation-layout, blend,
eval, workers, ui-architecture, scaling, multi-level.

The live palette of card choices + valid orderings + auto-spawn rules is
`cards.md` at the project root (Mermaid diagram + semantics notes). Treat
it as the single source of truth for **which cards exist** and **which
parents they attach under** — `doc/plan.md` records the why; `cards.md`
records the what.

**Shipped:**

- Six-layer pipeline (datasource → dimred [5 sub-stages incl. fusion] →
  clustering [multi-level] → citations → layout → blend) — see the
  per-layer docs.
- Eval / Optimise: bootstrap stability, target-range sweep, dim-sweep,
  scorers (§6, `doc/eval.md`).
- **Workflow-tree redesign (Phase 2, slices 2.1 → 2.12)** — the chart is
  the primary surface; branching tree of analysis cards, per-step queue
  jobs, saved-mode panels, cross-source comparison cards, next-step
  affordances (§8).
- **Workflow-tree UX pass (2026-05-30):** natural-size chart (no spinner
  ballooning), ⚙ gear opens config / click only selects, blue
  in-card running spinner, **empty-start workflow** (no pipeline
  auto-run on boot), per-card **+** add-step buttons, and **granular
  build-out** (add-data creates only a data card; dim-reduction doesn't
  auto-run clustering).
- **Multi-level clustering + tree scoring + bridge clusters (§9, shipped
  2026-05-31, MLC-0 → MLC-5):** one HDBSCAN run → its condensed tree is
  surfaced (MLC-0) and cut into a coarse→fine partition ladder
  (`clustering-multilevel.js`), with noise-stripped points absorbed into
  the nearest live cluster over the MST so a fine cluster can bridge two
  coarse parents (the user-chosen "absorbed cuts"). An **Optimise
  multi-layer** card runs it; the **bridge panel** splits fine clusters
  into Encapsulated/Bridges by a dominance threshold τ; the **tree scoring
  panel** takes 1–5 scores layer-by-layer with parent-score threshold
  propagation (persisted on `state.clusterScores`); a multi-method
  **labelling module** (`labelling/cluster-labels.js`) labels clusters
  (representative paper + year now; c-TF-IDF/TF-IDF gated until titles are
  materialised). The dominant O(n²·d) distance matrix fans out across cores
  (`workers/parallel-distance.js`).

**Active / next:**

- Nothing queued. Possible follow-ups: materialise paper titles so the
  text labelling methods light up; a KeyBERT method (needs a term encoder);
  re-cut saved trees at new λ without re-running HDBSCAN (surface the
  weighted MST).

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
- α = 1: **citation-graph layout** (FR, MDS, or UMAP-on-graph —
  the three algorithms currently registered in
  `citation-layout/registry.js`) — what the citation topology
  alone says.

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

**On-demand stability** — ✓ shipped (beta) as a **stability-analysis
sidecar to clustering** via the clustering modal's Configure tab (Validate
tab retired 2026-05-24 per §6.18.1). Bootstrap-Jaccard with Hennig
thresholds (`HENNIG_STABLE = 0.85`, `HENNIG_DOUBTFUL = 0.60`). The
"Stability (bootstrap)" section is folded into Configure as part of the
cards.md consolidation (plan §10). Beta caveat: interface and scorer
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
| **Modal infrastructure** | `modals/modal.js` (generic dialog), `modals/algorithm-modal.js` (single-level layer config — used for citation layout), `modals/clustering-modal.js` (**tabbed**: Configure / Optimise — the only modal with internal tabs today; Configure carries the new "Stability (bootstrap)" section folded in via cards.md Pass 2b. Tab strip styled to match the panel-system tab bar), `modals/dimred-modal.js` (**five-stage** — noise / fusion / compression / viz (3D) / viz2d (2D) sections, slot-filtered dropdowns), `modals/data-source-modal.js` (data-source registry picker + per-source params, opened from the workflow-chart Data card), `modals/panel-picker.js`. All modals show a `Running…` progress indicator on Apply for async work. |
| **Viewer panels** | `panels/viewer-3d.js` (3d-force-graph WebGL) and `panels/viewer-2d.js` (force-graph canvas) both delegate colour-mode resolution to `viewer-shared/colour-modes.js` — same colour-by dropdown options, same selection-dim logic, same per-cluster palette. Each reads its own positions slot (`_basePos` / `_basePos2d`) populated by the matching Layer 1.5 viz sub-stage. |
| **Eval engine** | `app/src/eval/{jaccard,bootstrap,scorers,sweep}.js` — pure functions consumed by the clustering modal's Stability (bootstrap) sidecar (single-config bootstrap-Jaccard) and Optimise (cross-algorithm parameter sweep). The standalone Validate tab was retired 2026-05-24 (§6.18.1). Four scorers: `ariScorer` (toy), `stabilityScorer` (Hennig), `numClustersScorer` (raw count), `clusterRichnessScorer` (count × meanJaccard, real-data default). Algorithm registry entries can mark a field `resolution: true` to opt into resolution-only sweeps (default). Hennig thresholds (`HENNIG_STABLE = 0.85`, `HENNIG_DOUBTFUL = 0.60`). |
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

**This doc (`doc/plan.md`) is the single plan/roadmap** — the former
`workflow-tree-redesign.md` and `multi-level-clustering-plan.md` were
folded in (§8, §9) and deleted 2026-05-30. Everything else is per-layer
reference, indexed by `doc/dynamics.md`:

- **Index:** `doc/dynamics.md` — layer index / conceptual model.
- **Per-layer:** `doc/dimred.md` (Layer 1.5), `doc/fusion.md` (1.5
  fusion sub-stage), `doc/clustering.md` (Layer 2), `doc/multi-level.md`
  (multi-level clustering + bridge analysis), `doc/citations.md` (Layer
  3), `doc/citation-layout.md` (Layer 4), `doc/blend.md` (Layer 5).
- **Subsystems:** `doc/eval.md` (Optimise / scorers / bootstrap),
  `doc/workers.md` (worker DAG), `doc/ui-architecture.md` (state, panels,
  persistence, the workflow tree).
- **Research / scaling:** `doc/clustering-research.md`,
  `doc/scaling.md`, `doc/dim-sweep-results.md`.
- **Still pending:** `doc/method-manual.md` (§6.10) — user-facing
  teaching manual; not yet written (`README.md` is the current manual).

---

## 6. Sequencing — shipped log (condensed)

Status legend: ✓ done · ◐ partial · ☐ pending/deferred · ↻ done
differently. Almost all of §6 shipped; each item is one line (detail in
the per-layer docs + git). The workflow-tree work (§6.20) is now §8; the
multi-level / scoring / bridge plan it enables is §9.

**Shipped:**

- **6.0 UI infrastructure** ✓ — workflow chart + multi-tab panels + modal
  infra. Extended by §8.
- **6.1 Multi-level clustering** ✓ — `clusterLevels[]`, global /
  within-parent scope. `doc/multi-level.md`.
- **6.2 connected-components** ✓ — first registry-added clustering algo.
- **6.3 Bridge analysis** ✓ — multi-scale boundary detection between
  cluster levels; per-coarser-level share breakdowns. `bridge-analysis.js`.
  Basis for §9 bridges (`boundaryScore = 1 − dominantFraction`).
- **6.4 Dim-reduction layer (1.5)** ✓ — registry + contract + engine lane
  + modal. `doc/dimred.md`. (6.4a UMAP, 6.4b real ingest
  `datasource/real.js`, 6.4c real citation-edge carving, 6.4d BFS-5000
  connectivity-aware carve = default real dataset.)
- **6.11 Web Worker port** ✓ — `runInWorker` + `runDAG`. `doc/workers.md`.
- **6.13 Global busy indicator + queue** ✓↻ — shipped then RETIRED by
  slice 2.11; cards carry their own status now.
- **6.14 Citation layout for sparse large graphs** ✓ — `umap-graph`.
  `doc/citation-layout.md`.
- **6.15 Citation-aware fusion** ✓ — APPNP anchored diffusion
  (`graph-diffusion`). `doc/fusion.md`.
- **6.16 Citation layout opt-in** ✓ — cascade stops at Layer 3; explicit
  Apply.
- **6.17 Target-range sweep** ✓ — Optimise mode hunting a cluster-count
  band (`runTargetRangeSweep`). `doc/eval.md`. Reused by §9's fallback.
- **6.5 Stability + Optimise tabs** ✓ (beta) — bootstrap-Jaccard +
  scorers (ARI / stability / richness / numClusters). `doc/eval.md`.
- **6.18 Optimise hardening** ✓ — scorer set + scoring v2/v3 +
  target-range bootstrap.
- **6.19 Validation runs as first-class entities** ✓ —
  `state.validationRuns`; the basis the workflow-tree cards generalised
  (§8).
- **6.6 Save / load project** ✓ — zip + binary payloads via fflate.
- **6.7 2D viewer panel** ✓ — viewer-2d singleton.
- **6.9 ARI dim-sweep validation** ✓ — stable-dimension finder; default
  compression bumped 50 → 100. `doc/dim-sweep-results.md`.
- **6.20 Workflow-tree redesign** ✓ — Phase 1 + 2 (all slices). Full
  writeup in **§8**.

**Deferred / future:**

- **6.8 Real-data pipeline ports** ☐ — deferred indefinitely; the real
  pipeline stays in `literture-network/`, the toy reads its materialised
  outputs.
- **6.10 `doc/method-manual.md`** ☐ — not written.
- **6.12 User-supplied data import (file browser)** ☐ — deferred
  (2026-05-20): the incoming-data shape will change when the DB-backed
  source lands; building a picker against today's `paper_index.json` +
  `citation_edges.json` would just need rewriting. Revisit after the DB
  layer.
- **Parallel track** ☐ — compression / subsampling to load a ~10 k slice
  of the 810 k corpus into the toy for interactive exploration. Out of
  scope for now.


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
  Deferred (per user 2026-05-26) until auto cluster recursion is
  designed — it'll be coupled to the Optimise tab and is a
  carefully-design slice. The §6.20 workflow-tree restructure has
  to land first so the clustering machinery's surrounding metrics
  + logging are surfaced before we design the recursion.
- ~~**Subsample size for the toy at real-data shape.**~~ Resolved
  2026-05-26 — BFS-5000 is the default test fixture; user confirmed
  5k is fine for current work. Future scale-up to 10k/20k is a
  separate parallel track if needed.
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

## 8. Workflow-tree redesign — shipped (Phase 2 complete)

The toy is now **workflow-centric**: the chart (`workflow-chart.js`) is
the primary surface, not a status rail. The user grows a branching tree
of analysis cards; each card is a queue job; each result is a first-class
entity renderable as a saved-mode panel. The viewer is one renderer among
many. Full architecture: `doc/ui-architecture.md`. History: git log
`feat(workflow): Phase 2 slice 2.*`.

**Locked design decisions (D1–D7):**

- **D1 Cards are unique per result, immutable once done.** Re-running
  with new params creates a NEW sibling card; the old one stays
  browsable. Done is terminal.
- **D2 Stale is computed, not cascaded.** A card is stale when
  `parent.revision !== this.upstreamRevision`. Renderer shows an amber
  dashed border + ↻ re-run button (resolved O3). No auto-cascade — each
  level needs explicit user action.
- **D3 All jobs are cards.** Optimise, bootstrap, dim-sweep, fusion-
  comparison, save/load, data ingest — all become cards bound to
  `queue.js` jobs. The bottom busy-bar was retired (slice 2.11).
- **D4 DAG, not strict tree.** `refIds` allow fan-in (a fusionComparison
  card references two clustering cards). Renderer draws `parentId` solid,
  `refIds` dashed.
- **D5 Live-mode panels disappear.** Panels bind to a card id (saved
  mode); there is no "latest" live mode.
- **D6 Branch deletion cascades** (with a confirm listing what's lost).
- **D7 No save-size cap initially** — the zip + binary-payload format
  handles arbitrary blobs; revisit at ~50 cards.

**Open questions:** O2 (viewer for comparison cards → show the candidate)
+ O3 (stale visual) resolved. O1 (multi-level card shape) → decided in §9
(hybrid). O4 (large-save strategy) deferred-until-pain.

**Slices 2.1 → 2.12 (all shipped):** state.workflow + CRUD (2.1),
legacy→tree migration (2.2), tree renderer (2.3), step↔job binding +
spinner (2.4), modal-as-step-creator (2.5), stale propagation (2.6),
back-compat projection layer (2.7), branching layout (2.8), bootstrap +
dim-sweep + save/load as cards (2.9), dead-UX cleanup + busy-bar removal
(2.11), cross-source comparison cards (2.10), next-step affordances
(2.12).

**UX pass (2026-05-30), on top of Phase 2:**

- **Natural-size chart** — the SVG renders at its viewBox pixel size
  (`max-width:100%`, never scales up), so a small tree's cards/spinner no
  longer balloon to fill the rail.
- **Click ≠ edit** — clicking a card only selects it + switches the
  viewer; a ⚙ gear icon (bottom-right) opens the config modal.
- **Blue in-card running spinner** — replaces the status dot while a
  card's job runs (`transform-box: fill-box` so it spins in place).
- **Empty-start workflow** — no pipeline auto-run on boot
  (`main.js`); the chart shows a "+ Add data source" affordance and the
  viewer starts empty.
- **Per-card + add-step buttons** — each card's base has a **+** opening
  an "Add step" menu (shared rule table with the next-steps panel) that
  forks a child card.
- **Granular build-out** — adding a data source creates ONLY a data
  card (`engine.ingestDataOnly()`); adding dim-reduction does NOT
  auto-run clustering (`redimred({cascade:false})`). The user builds one
  layer at a time. `reingest()`/`regenerate()` keep the full cascade for
  any caller that wants it (tests, project load).

## 9. Multi-level clustering + tree scoring + bridge clusters — active plan

*(Folded in from the former `doc/multi-level-clustering-plan.md`, 2026-05-30. Decisions are locked; no code yet.)*

**Status (2026-05-30): decisions incorporated — ready to slice.** This is
a design plan, not shipped work. It collects the feature request from
`pending_changes.md` (Features §1) into a concrete, phased plan grounded
in the existing machinery. The user's decisions (originally flagged
**[DECIDE]**, answered inline as **[USER]**) are now folded into each
section as **Decided**.

This addresses the deferred open question **§10.O1** in
`doc/workflow-tree-redesign.md` (how the workflow tree presents
multi-level clustering) and the long-pending scoring re-scope in
`doc/plan.md` §6.18/§6.19.

### 1. Vision (restated from the request)

The user wants to **discover how many resolution layers naturally emerge
from the topology** of the 100-d embedding, then cluster each layer at
its natural granularity and explore the result with a **simple
layer-by-layer scoring** workflow:

- **Highest layer = lowest resolution** — few clusters. For the current
  dataset the user's own exploration puts this at **~8–12 clusters**. A
  *simple test* should determine that range automatically rather than
  the user guessing it.
- **Each lower layer = higher resolution** — more clusters. The number
  of layers is unknown and should be **data-derived**, not fixed.
- For each layer, **search for the optimal clustering settings that land
  the cluster count inside that layer's target range**.
- The highest-resolution layer has many clusters — that's fine, because
  **scoring + labels let the user filter** down to what matters.

And a **re-scoped scoring system** (replacing the old Shiny scoring app,
which "does far too much"):

- The scorer should do *one thing*: **present a cluster's label and ask
  the user to score it 1–5.**
- Scoring is **layer-by-layer**. At the top layer the user scores the
  few coarse clusters. Moving to the next (finer) layer, the labels
  presented are **filtered by the parent layer's scores** via a
  **manipulable threshold** — raise it to see only children of
  high-scored parents, lower it to widen.
- Because the preferred clustering is **global** (not strictly
  hierarchical), a fine cluster can draw members from **two coarse
  parents** — these are **bridge clusters**. They:
  - are shown/hidden by the threshold,
  - carry **multiple parent scores** (displayed for transparency),
  - are ordered by their **highest parent score**,
  - are **sectioned separately** so the user can focus on cleanly
    encapsulated clusters independently of the bridges.

The tree-style workflow is the enabler: the user can score in different
ways (different threshold settings, different parent layers) and keep
each as a branch.

### 2. What already exists (leverage points)

A lot of the machinery is already here — this feature is mostly
*orchestration + a new scoring surface + a bridge panel*, not new
algorithms.

| Need | Exists today | File |
|---|---|---|
| Multi-level partitions | `clusterLevels[]` — array of `{uid, scope, clusterResult}`; `scope` is `"global"` or `"within-parent"` | `app/src/clustering-cascade.js` |
| Search settings for a target cluster-count range | `runTargetRangeSweep()` — Phase-1 Latin-hypercube probe + Phase-2 refine; ranks configs that land in `[targetMin, targetMax]` | `app/src/eval/sweep.js` |
| Optimise UI driving the sweep | Optimise tab (target-range mode, per-row Apply, level picker) | `app/src/ui/modals/clustering-tabs/optimise-tab.js` |
| Multi-parent fine clusters (the bridge primitive) | `bridge-analysis.js` — per fine cluster, share breakdown against **every** coarser level, `spanCount`, `dominantFraction`, `isBridge` | `app/src/ui/bridge-analysis.js` |
| Dim / cluster-count stability signal | `dim-sweep` — per-dimension cluster counts + pairwise ARI heatmap | `app/src/eval/dim-sweep.js` |
| Scorers (numClusters, richness, ARI, stability) | `scorers.js` | `app/src/eval/scorers.js` |
| Workflow-tree cards + branching + saved-mode panels | Phase 2 (shipped) | `doc/workflow-tree-redesign.md` |

**Gaps to build:**

1. **Auto layer-range discovery** — a "simple test" that turns the 100-d
   space into a list of natural cluster-count ranges, one per layer. The
   dim-sweep gives cluster-count-vs-dimension but there's no automated
   "find the plateaus / knees." *(New.)*
2. **Layer cascade driven by discovery** — run `runTargetRangeSweep`
   once per discovered range, coarsest→finest, producing the
   `clusterLevels[]`. *(Mostly orchestration over existing sweep.)*
3. **Minimal tree scoring surface** — a 1–5-per-cluster scorer with
   per-layer threshold propagation. No in-toy equivalent exists; the old
   Shiny scoring app is external and explicitly out of scope. *(New.)*
4. **Bridge-cluster panel** — threshold-filtered, multi-parent-score,
   sectioned display. The *analysis* exists; the *panel* does not. *(New
   panel over existing `bridge-analysis.js` output.)*
5. **Multi-level card shape** in the workflow tree (§10.O1). *(New.)*
6. **Labelling** — there is currently **no cluster labelling at all** in
   the toy (clusters are numeric ids). TF-IDF is a real-data concern;
   see §7. *(New, real-data only.)*

### 3. Layer-range discovery (the "simple test")

Goal: from the 100-d embedding, output an ordered list of target
cluster-count ranges — coarsest first — without the user guessing.

**Decided: HDBSCAN — and extract ALL layers from a single stored run's
hierarchy, not from repeated range-sweeps** (per [USER] below). One good
HDBSCAN run already builds a condensed cluster tree; the layers are
*cuts* of that one tree at different stability levels. This is far more
elegant (and cheaper) than running `runTargetRangeSweep` once per layer.
It becomes a new **"Optimise multi-layer"** mode in the Optimise modal;
the existing modes (single-config, target-range, full sweep) stay as-is.
See §4 for how the single-run extraction works and the **one caveat**:
the toy's HDBSCAN result must expose the condensed-tree / per-λ cluster
counts (today it stores flat labels + per-cluster `stability`; we likely
need to surface the condensed tree from the worker).

> [USER] note answering "is the full sweep the same results?": a *full
> sweep* is many independent flat partitions at different params — useful
> as a fallback source of "what cluster counts are achievable," but it is
> **not** the same as one run's hierarchy. The elegant path is the single
> run's condensed tree; the stored sweep is a Plan-B input for the
> algorithm-agnostic fallback (§3.B).

The candidate signals considered (cheapest first):

**[USER] i agree that HDBSCAN is a good choice here**. using these results we can maybe also avoid having to use teh range optimisation. if we do one good soil run of HDBSCAN and store resutls (we alerady do this) we can simply find the layers from that. this is much more elegant than running range optisation runs over and over again. we'll include this in the optimize modal, when optimize multilayers is selected this is the apraoch. the other options can remain as they are. for intance is the full sweep is used. thoes stored results can techinally be used for the multilayerd part. it's teh same results isn't it?

- **A. HDBSCAN condensed-tree persistence (recommended).** HDBSCAN
  already builds a condensed cluster tree with per-cluster stability
  (persistence). The number of clusters that survive at increasing
  `min_cluster_size` / persistence thresholds gives a natural ladder of
  resolutions. Read the persistence spectrum once; the "shelves" where
  the surviving-cluster count is stable across a band of thresholds are
  the natural layers. Fits the existing HDBSCAN path; no new dependency.
- **B. Cluster-count plateau from a resolution sweep.** Sweep one
  resolution knob (e.g. `minClusterSize` or `mutualK`) across its range,
  record cluster count, and find the **plateaus** (bands where the count
  barely changes) — each plateau is a natural layer, its count the
  target. Reuses `sweepAcrossAlgorithms` machinery; algorithm-agnostic.
- **C. Dim-sweep cluster-count knee.** Reuse `dim-sweep`'s per-dimension
  cluster counts and look for the stable region. Weakest fit — dim-sweep
  is about *compression dimension* stability, not resolution layers.
- **D. Eigengap / silhouette sweep.** Classic but needs new code and is
  sensitive to metric choice; heavier than A/B.

**Lean: A (HDBSCAN persistence) as the primary signal, B as the
algorithm-agnostic fallback** (mutual-kNN has no persistence tree). Both
output the same contract:

```
discoverLayers(input100d, opts) → [
  { layer: 0, targetRange: [lo, hi], rationale: "persistence shelf @ ..." },
  { layer: 1, targetRange: [lo, hi], ... },   // finer
  ...
]
```

The top layer's range should match the user's empirical ~8–12 for the
current dataset — a useful validation check for whichever signal we pick.

**Decided: cap = 5 layers.** Data-derived count, hard-capped at 5 — more
than that and the scoring workflow becomes bloated.

**[USER] 5 is a good sounding cap.** any larger and it becomes bloated and un nessacery.

### 4. The layer cascade (single-run extraction)

**Decided (§3): extract the layers from ONE HDBSCAN run's condensed
tree** — no per-layer range-sweep. The condensed tree is already a
hierarchy; each layer is a horizontal cut at a different stability (λ)
level, yielding progressively finer partitions.

```
run = runHDBSCANWithTree(input100d)        // one run; emits condensed tree
counts = clusterCountAtEachLambdaCut(run)  // how many survive vs λ
shelves = stablePlateaus(counts, capLayers = 5)   // the natural layers
for each shelf (coarse → fine):
    partition = flattenTreeAtLambda(run, shelf.lambda)   // global labels
    push { uid, scope: "global", clusterResult: partition } onto clusterLevels
```

Notes:

- **Global scope** (so fine clusters can bridge coarse parents — the
  whole point of §6). We do *not* use `within-parent` scope; the cuts are
  of the same global tree, so a fine cluster can straddle two coarse
  ones naturally.
- **No per-range scorer needed** for the HDBSCAN path — the tree gives
  the partitions directly. (The old [DECIDE] "best-in-range scorer" only
  applies to the §3.B algorithm-agnostic *fallback*, where richness
  remains the recommended ranker.)
- **Caveat / prerequisite:** the toy's HDBSCAN currently stores flat
  labels + per-cluster `stability` but not the full condensed tree.
  MLC-1/MLC-2 must surface the condensed tree (parent/λ/child) from the
  HDBSCAN worker so the cuts can be computed. This is the main new
  engine work; everything downstream is orchestration.
- This is a long-running job → a **workflow card** with a queue job
  (mirrors the dim-sweep / optimise runners). See §6.

### 5. Tree scoring (replace the old scoring app)

A new minimal scoring surface. **One job: show a cluster's label, take a
1–5 score.** Layer-by-layer, with parent-score threshold propagation.

#### 5.1 Data model

Scores live on the workflow (so they persist + branch):

```
score = { levelUid, clusterId, value: 1..5, scoredAt }
state.workflow ... scores: { [levelUid]: { [clusterId]: value } }
```

**Decided: a dedicated "scoring" card** bound to the multi-level
clustering card via `refIds`, so the user can keep multiple scorings of
the same clustering as separate branches (the tree-branch story the user
wants). Scores are not stored on the clustering card itself.

#### 5.2 Interaction

1. **Top layer first.** Present each coarse cluster: its **label**
   (§7), size, colour swatch, and a 1–5 control. User scores them.
2. **Descend a layer.** Now present the finer clusters, but **filtered
   by a threshold slider** on the parent score: only show fine clusters
   whose dominant parent scored ≥ threshold. Raising the threshold
   narrows to children of the best parents; lowering widens.
3. Each fine cluster shows **which parent(s) it came from and their
   scores** (transparency), so the user understands why it's visible.
4. Repeat down the layers.

#### 5.3 Threshold propagation + bridges

- A fine cluster's **parent set** comes straight from
  `bridge-analysis.js` (`perCluster[i].byLevel[parentLevel].shares` →
  the coarse cluster ids it draws members from, with fractions).
- **Encapsulated** fine cluster: one dominant parent (`spanCount === 1`
  or `dominantFraction ≥ τ`). Shown iff that parent's score ≥ threshold.
- **Bridge** fine cluster: `spanCount ≥ 2` (members from 2+ parents).
  - Shown iff **any** parent's score ≥ threshold.
  - Displays **all** parent scores; ordered by the **highest** parent
    score.
  - Rendered in a **separate "Bridges" section** beneath the
    encapsulated clusters, so the two are explored independently.

**Decided: dominance cutoff τ defaults to 0.8, adjustable in the scoring
modal.** A fine cluster with `dominantFraction ≥ 0.8` is *encapsulated*;
below that it's a *bridge*. `bridge-analysis.js` already computes
`dominantFraction`; we threshold it, and expose τ as a slider so the
user can tighten/loosen the encapsulated-vs-bridge split live.

**[USER] agree on using threshold** set the defult to 0.8, with the threshold changable within the scoring modal.

### 6. Bridge-cluster panel + workflow-tree fit

#### 6.1 Bridge panel

A new saved-mode panel rendering `bridge-analysis.js` output for a
selected multi-level clustering, with:

- a parent-level picker + the dominance threshold τ slider,
- two sections: **Encapsulated** and **Bridges**,
- per bridge row: fine id, member count, each parent id + share + parent
  score, sorted by highest parent score.

This is largely a renderer over data that already exists; the new logic
is the threshold filtering + the score join.

#### 6.2 Card shape (§10.O1)

Per `doc/workflow-tree-redesign.md` §10.O1 the lean is the **hybrid**:
one **multi-level clustering card** carrying the discovered
`clusterLevels[]`, with **per-layer sub-cards** as children for
layer-specific work (re-optimise a single layer, score a layer). A
**scoring card** binds to the multi-level card; a **bridge card** binds
to it too.

**Decided: hybrid card shape** (one multi-level clustering card +
per-layer sub-cards; scoring + bridge cards bind via `refIds`). Keeps
"this clustering grew to N layers" legible while making per-layer work
first-class, and matches the per-card `+` add-step UX (UI #2). Note the
viewer already has a **colour-by-layer** mode, so visualising the
clusters at any level is already supported — selecting a layer sub-card
(or a scoring threshold) just drives which level the viewer colours by.

**[USER] agree** we have the colour by layer in the veiwer anyway, so if the user wants to visulize the clusters at lower levels and surface that data we already have that included.

### 7. Labelling (TF-IDF and alternatives)

There is **no cluster labelling in the toy today** — clusters are
numeric ids. Labels are a **real-data** concern (papers have
titles/abstracts; the toy's synthetic nodes have none). The user notes
TF-IDF "might not be the best method."

**Decided: labelling is its own module that can run MULTIPLE methods and
combine/compare them** (real-data only). KeyBERT is the preferred method,
but all of them are worth shipping — computing several and showing them
side-by-side adds defensibility: for a cluster that's interesting or
hard to score, the user compares the different methods' labels. The
module contract returns labels per method so the scoring surface can
show one or many:

```
label(clusterMembers) → { byMethod: { keyBERT: {...}, cTfidf: {...},
                                      tfidf: {...}, exemplar: {...} },
                          combined: {...} }
```

**[USER] agree on this being it's own module**, i favour the keyBERT method, but shiping, each of these method is a good choice, and being able to combine the labels will add in defensability. for example we decide to compute all of the methods, and we cherry pick some clusters that are of interest or we're having troubling score and compare the differnt labels.

- **TF-IDF over cluster member titles/abstracts** — cheap, interpretable,
  the conventional baseline; weak on multi-word concepts and stopword-ish
  domain terms.
- **c-TF-IDF (class-based, à la BERTopic)** — TF-IDF computed per cluster
  treated as one document; usually crisper topic words than plain TF-IDF.
- **KeyBERT / embedding-centroid nearest terms** — use the SPECTER2
  embedding: label = the title phrases nearest the cluster centroid.
  Reuses the embedding we already have; no bag-of-words.
- **Representative-paper** — just show the paper nearest the centroid as
  the "label." Zero NLP; surprisingly legible.

Per the decision above, ship **KeyBERT (preferred) + c-TF-IDF +
representative-paper** behind the one module, computed together so the
scoring surface can show/compare them. Plain TF-IDF is the cheap
baseline. The module stays swappable — adding a method is one registry
entry, like the clustering / scorer registries.

### 8. Phasing — SHIPPED 2026-05-31

Each phase shipped independently with pytest coverage (`tests/
test_condensed_tree.py`, `test_multilevel.py`, `test_cluster_labels.py`,
`test_scoring.py`). What landed, and where it diverged from the plan:

- **MLC-0 ✓ Condensed tree surfaced.** `clusterResult.condensedTree` — a
  compact, clone-safe projection (node-parallel parent/birthLambda/
  stability/size/selectedLabel + per-leaf home/leafLambda). It was already
  computed inside HDBSCAN and discarded; now serialised, validated, and
  persisted. `app/src/clustering-hdbscan.js`.
- **MLC-1 ✓ Layer discovery.** `discoverLayers()` ranks λ-shelves by
  scale-invariant **log-λ persistence** (cap 5), coarse→fine.
  `flattenFrontier()` cuts the tree. `app/src/clustering-multilevel.js`.
- **MLC-2 ✓ Layer cascade card.** `inferHdbscanMultiLevel` does it all in
  ONE run; `buildMultiLevel` keeps only layers that strictly REFINE the
  previous (high-λ cuts collapse under absorption, so structural count ≠
  realised count). "Optimise multi-layer" is a standalone modal reached
  from the dimred card's **+** (not folded into the big Optimise tab — same
  effect, less risk). Multi-level card + projection + worker `multilevel`
  mode + `engine.recomputeMultiLevel`.
- **Absorbed cuts (user decision).** Frontier cuts of one tree are strictly
  nested ⇒ zero within-tree bridges. So noise-stripped points are absorbed
  into the nearest live cluster by **multi-source Dijkstra over the MST**
  (`absorbViaMST`, O(n log n), cross-branch) — that's what makes a fine
  cluster straddle two coarse parents. (The plan's claim that pure tree
  cuts "straddle naturally" was wrong; absorption is the bridge source.)
- **MLC-3 ✓ Bridge panel.** Enhanced `panels/bridge-analysis.js` with the
  τ dominance slider (default 0.8) splitting Encapsulated vs Bridges.
- **MLC-4 ✓ Labelling module.** `labelling/cluster-labels.js` — registry of
  representative-paper + year (work on real data) + c-TF-IDF/TF-IDF
  (implemented + unit-tested via an injected text accessor). **The real
  subsets materialise only paperId + embedding — no titles/abstracts — so
  the text methods gate with a reason until a titles source is wired into
  `ctx.getText`.** KeyBERT deferred (needs a term encoder).
- **MLC-5 ✓ Tree scoring.** `panels/cluster-scoring.js` — a singleton
  PANEL (not a separate card type; simpler, and cards aren't persisted
  anyway). 1–5 layer-by-layer, parent-score threshold filter, bridges
  section, scores on `state.clusterScores` keyed by **level uid** (so each
  clustering branch keeps its own scores) + persisted via save/load.
- **CPU scaling (user ask).** The dominant O(n²·d) distance matrix fans out
  across cores via nested `workers/distance-worker.js` +
  `parallel-distance.js` (sync fallback; no SharedArrayBuffer — no
  COOP/COEP). MST-based absorption made the per-layer cost O(n log n), so
  the 5 layers are nearly free over one HDBSCAN run.

### 9. Decisions (resolved)

All originally-open points are now decided (per the user's inline
answers):

- **§3 discovery signal** → HDBSCAN, extracting layers from a single
  run's condensed tree (not repeated range-sweeps); algorithm-agnostic
  sweep-plateau fallback for non-HDBSCAN. **Layer cap = 5.**
- **§4 cascade** → flatten one HDBSCAN tree at each λ-shelf; no per-range
  scorer for the HDBSCAN path (richness only for the fallback).
- **§5.1 scores home** → a dedicated scoring card bound via `refIds`
  (enables multiple scorings as branches).
- **§5.3 dominance cutoff τ** → default 0.8, adjustable in the scoring
  modal.
- **§6.2 card shape** → hybrid (multi-level card + per-layer sub-cards);
  viewer reuses the existing colour-by-layer mode.
- **§7 labelling** → its own multi-method module (KeyBERT preferred,
  plus c-TF-IDF + representative-paper), computed together and
  comparable; real-data only.

Remaining genuinely-open item: **the condensed-tree surfacing (MLC-0)** —
confirm the HDBSCAN worker can expose the tree without a heavy rewrite
before committing to single-run extraction. That's the first thing to
prototype.

### 10. Explicitly NOT in this plan

- Re-integrating the external Shiny scoring app (stays separate per
  `doc/plan.md` §1). This plan builds a *minimal in-toy* scorer instead.
- New clustering algorithms — we reuse HDBSCAN / mutual-kNN via the
  existing registry + cascade.
- Changing the global-clustering preference — bridges depend on it.

## 10. Card palette consolidation — shipped 2026-06-03 → 2026-06-04

After §8 + §9 landed, the chart had collected analysis cards
(`bridgeAnalysis`, `bootstrapStability`, `crossClusterCitations`,
`nodeDisplacement`, `fusionComparison`) that were either functionally
redundant with their parent's job (bootstrap was running anyway during
the multi-level sweep), or sat as their own card when they were really
sidecars to the card above. A user-driven pass collapsed the palette and
folded the canonical Mermaid + semantics map into **`cards.md`** at the
project root — that file is now the live source of truth for which cards
exist, what they auto-spawn, and how children attach.

**Pass 1 (additive, shipped 2026-06-03):**

- **1a — per-pair bridge counts in the sweep.** `bridge-analysis.js`
  gained `computeBridgesPerPair(candidates)`: a lean Int32 matrix of
  bridge counts for every (child, parent) candidate pair. Wired into
  `engine.recomputeMultiLevelSweep` so the result rides alongside
  `candidates` + `curve` on `state.multiLevelSweep`.
- **1b — picker panel reshape.** The multi-layer picker is now a
  two-column body (stability curve | bridge heatmap) with a live
  readout of bridge counts between adjacent picks. Curve dots and
  heatmap rows/cols cross-bind on click. Heatmap reads the per-pair
  matrix from the producer with no recompute.
- **1c — crossCluster auto-spawns under the picker** when the ladder
  commits. Gated on `state.rawCitationEdges` being non-empty so toy
  data without citations doesn't get a perma-failed card. Still
  available as a manual `+` option on single-level clustering.
- **1d — nodeDisplacement auto-spawns from the dimred fork** once both
  pre + post fusion branches exist (it's a property of the fork itself,
  no clustering needed). Dropped from the fusionBranch `+` menu.

**Pass 2 (breaking, shipped 2026-06-03 / 2026-06-04):**

- **2a — `bridgeAnalysis` card type deleted.** The algorithm + runner
  stay callable; the picker's commit job populates `state.bridgeAnalysis`
  directly (already did via `engine.commitMultiLevelLayers`), and the
  singleton bridge panel reads it. Labelling now hangs directly off the
  picker (picker → labelling → scoring → export). Hard break — old saved
  projects with bridgeAnalysis cards load via migration but the gear
  opens nothing.
- **2b — `bootstrapStability` card type deleted.** Knobs (B,
  subsampleFrac, minMembers, noiseHandling, enabled) moved into the
  clustering modal's new "Stability (bootstrap)" section. `engine.recluster`
  runs the bootstrap sidecar after HDBSCAN (single-level only —
  multi-level paths still bootstrap per granularity inside the sweep
  curve), writing `state.bootstrapStability` for the panel. Same hard
  break.
- **fusionComparison kept as a placeholder.** The full 575 LoC
  implementation stays — cross-branch comparison is only meaningful when
  both clusterings used identical settings, and ripping out a working
  comparator we may want back was the wrong move. Instead the modal,
  panel, and every next-steps hint carry a `⚠ Placeholder · pending
  further work` banner.

**Post-pass refinements (2026-06-04):**

- **Per-card-type panel slot routing** (`panel-system.js
  SLOT_FOR_CARD_TYPE`): the high-touch picker + scoring panels open in
  `primary`; cross-cluster citations opens in `secondary`; everything
  else stays in `bottom`.
- **crossCluster sits on the analysis chain.** New
  `preferCrossClusterChild(clusteringId)` helper used by labelling /
  scoring / export's `resolveParent`: when a crossCluster card exists
  under the clustering ancestor, it becomes the effective parent. Tree
  fills in as picker → crossCluster → labelling → scoring → export.
  Added `projectCrossClusterCitations` + `state.crossClusterCitations`
  slot so any descendant reads the citation-flow matrix via projection
  rather than walking the tree.

**Decisions locked:**

- **C1 Bridge as algorithm, not card.** The picker curve already shows
  stability per granularity; the heatmap shows bridge density per
  granularity pair. A separate "Run bridge analysis" card was a click
  the user shouldn't have to make.
- **C2 Bootstrap as a sidecar.** Bootstrap-Jaccard belongs *with* the
  clustering it's measuring, not as a sibling card the user has to add
  + configure separately. Multi-level was already doing it; single-level
  now matches.
- **C3 Auto-spawn what has no params** (or one canonical config).
  Bridge (no params), crossCluster (no params), nodeDisplacement (no
  params). Labelling stays manual (algorithm pick) and stays the only
  manual `+` between picker and scoring.
- **C4 Per-pair bridge informs layer picking.** The picker is where the
  user decides which granularities to commit; surface bridge density
  there so the decision is informed by both stability *and* structural
  bridging.

**Out of scope for this pass:**

- `citationLayout` (kept in code; not in the user-driven flow).
- `citations` / `alignment` / `blend` (toy-graph chain; pinned for future
  work, untouched).
- A "select-node" hub that aggregates label / score / citation-degree /
  displacement signals for filtering — design TBD; shown on the cards.md
  diagram as a deferred placeholder.
