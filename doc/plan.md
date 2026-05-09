# Plan — converging the toy and the real pipeline

**Status:** in-flight. Decisions below are committed; the
sequencing in §6 has been substantially revised to reflect what's
actually been built. Pairs with `doc/clustering-research.md` for
the research that justifies the picks.

**Current state (2026-05-10):** the toy has been substantially
re-shelled with a new UI architecture (workflow chart + multi-tab
panels + modal infrastructure) that wasn't itemised in the
original plan but turned out to be the prerequisite for almost
everything else. Multi-level clustering with global / within-parent
scope is live. Mode-aware "node table" legend follows whatever's
colouring the 3D viewer. Selection is generalised across cluster /
origin / node types. `connected-components` is the first new
algorithm registered.

**Not yet started:** dim-reduction layer, bridge analysis (the
multi-scale derivation we discussed), real-pipeline Python port
(Layer 4/5a in scoring app), `Validate ▾` modal, method manual.

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

### 2.1 New stage: dim-reduction (Layer 1.5)

Currently the toy goes embedding → cluster directly. We add a
pluggable dim-reduction stage between embedding and clustering,
same registry pattern as every other layer.

```
app/src/dimred/
  registry.js                registry shell
  contract.js                output: Float32Array(n × d)
  identity.js                no-op (preserve embedding as-is)
  pca.js                     PCA (denoiser before UMAP, or alone)
  umap.js                    UMAP (default for clustering)
  pacmap.js                  PaCMAP (alternative)
```

Each entry: `{ id, defaultParams, compute, modalSchema }`. The
toy's existing UI auto-renders controls; the real pipeline's CLI
auto-derives flags.

The toy maintains **two independent dim-reduction outputs**:

- **Clustering reduction** (default `umap` to 50-d). What
  Layer 2 (clustering) actually consumes.
- **Visualisation reduction** (default `viz-umap` to 3-d, separate
  fit). The toy's basePos analogue at α = 0. **Never used for
  clustering.**

Real pipeline only needs the clustering reduction (it visualises
via UMAP-2d in the scoring app, separately).

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

- **Cluster sweep** ranks (algorithm × params) by composite
  metric: modularity + bootstrap-Jaccard + alignmentCorrelation
  + (where available) ARI vs known labels.
- **Layout sweep** ranks by `alignmentCorrelation` (already done).
- **Cluster-vs-cluster ARI** (Leiden vs HDBSCAN on same data) =
  per-paper disagreement signal, the cheap stability metric.

---

## 3. What we're building (registry contents)

### 3.1 Dim-reduction registry

| ID | Algorithm | Default params |
|----|-----------|----------------|
| `identity` | no-op | — |
| `pca` | PCA | `n_components=100` |
| `umap` | UMAP | `n_components=50, n_neighbors=50, min_dist=0, init='pca', metric='cosine', random_state=42, low_memory=True` |
| `pacmap` | PaCMAP | `n_components=50, MN_ratio=0.5` |
| `viz-umap` | UMAP | `n_components=3, n_neighbors=15, min_dist=0.1` (toy viz only) |

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

**Pending (the multi-scale boundary analysis):** the real
research question — "where are the boundaries between coarse
clusters?" — needs an additional layer that consumes two
adjacent `clusterLevels` and derives a per-node boundary score
plus bridge-cluster list. Promoted to a numbered item in §6.

### 3.5 Stability metrics

Two-tier (per `clustering-research.md` §1).

**Status:** partial.

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

**On-demand (`Validate ▾` modal)**: pending. Bootstrap-Jaccard
on a 50 k subsample (Hennig thresholds: ≥ 0.85 stable, 0.6–0.75
doubtful, < 0.6 not a cluster). Modal infrastructure is built
(`modals/modal.js`), so this is just a new modal entry + the
bootstrap loop in the engine.

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
| **Modal infrastructure** | `modals/modal.js` (generic dialog), `modals/algorithm-modal.js` (single-level layer config — used for citation layout), `modals/clustering-modal.js` (multi-level — algorithm + per-level params + scope toggle + ± levels), `modals/panel-picker.js`. |
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

### 6.3 Bridge analysis (the multi-scale derivation) ☐  **next priority**
Consumes two adjacent `clusterLevels` (coarse + fine). Derives:
- per-fine-cluster `coarseShares` histogram
- per-node `boundaryScore` (entropy or `1 − max(coarseShare)`)
- list of bridge clusters (fine clusters spanning ≥2 coarse)
- coarse-adjacency graph weighted by shared fine clusters

Surfaces:
- new `boundaryScore` colour mode in viewer-3d
- new `bridge` source in node-table
- new `bridgeAdjacency` source (one row per coarse-coarse pair)

No engine contract change — the analysis is a derivation on top
of existing `clusterLevels`. ~150 lines analysis + ~50 lines per
new node-table source.

### 6.4 Dim-reduction layer ☐
Build `app/src/dimred/` with `identity` + `pca` minimum, then
`umap` / `pacmap`. Adds the missing Layer 1.5 to the workflow
chart. At toy scale this is mostly architectural (basePos is
already 3-d so reduction is near-noop); becomes load-bearing
when the real-data port begins. Was originally item 1; demoted
because nothing currently blocks on it at toy scale.

### 6.5 Stability `Validate ▾` modal ☐
Bootstrap-Jaccard on a fixed 50 k subsample, B = 25, per-cluster
max-Jaccard. Hennig thresholds. Modal infra is built; this is
just the engine bootstrap loop + a result-rendering modal body.

### 6.6 Real-data pipeline ports ☐
Was items 5–7 in the original plan. Pending until the toy work
stabilises.
- Layer 4 (citation layout) — pivot MDS per Leiden component, in
  Python.
- Layer 5a (alignment) — `blend/align.js` ported to Python;
  runs on real-pipeline outputs.
- Layer 5b (per-frame blend) — α slider in scoring app; plotly
  scattergl repaints.

### 6.7 ARI dim-sweep validation ☐
Was item 4 (and §2.5). Depends on dim-reduction (6.4) being live.
Run the same clustering at UMAP target dim ∈ {30, 50, 100, 200},
ARI between resulting partitions, threshold check.

### 6.8 `doc/method-manual.md` ☐
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

### Still open (need data or judgment)

- **Boundary-score definition** for §6.3 bridge analysis. Three
  candidates: entropy of coarse-membership; `1 − max(coarseShare)`;
  count of distinct coarse clusters in the fine cluster. Each
  weights small minority shares differently. Pick when 6.3 starts.
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
