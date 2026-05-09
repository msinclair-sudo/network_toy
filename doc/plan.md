# Plan — converging the toy and the real pipeline

**Status:** lock-in ahead of build. The decisions below are
committed; sequencing is rough but each phase is independently
deliverable. Pairs with `doc/clustering-research.md` for the
research that justifies the picks.

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

### 2.2 Hierarchical `ClusterResult` contract

Current contract has flat `nodeCluster: Int32Array`. Real pipeline
emits paths (`L1.4.2`). Extend additively:

```ts
{
  ...existing flat fields...,
  nodePath?:    string[],             // optional, e.g. "L1.4.2"
  clusterTree?: {
    [path: string]: {
      parent:    string | null,
      children:  string[],
      depth:     number,
      ...existing per-cluster fields...
    }
  },
}
```

Validator: if `nodePath` is present, every entry must be a valid
path in `clusterTree`; depths consistent; `nodeCluster` matches
the top-level slice. Flat algorithms keep working unchanged.

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

Currently registered in toy: mutual k-NN, HDBSCAN. Real pipeline:
recursive Leiden CPM.

Adding (each = one registry entry):

| ID | Where | Notes |
|----|-------|-------|
| `hdbscan` | toy + real | extend existing toy entry; cuML at scale |
| `leiden-cpm` | toy | single-level baseline |
| `leiden-recursive` | toy + real | port real-pipeline algorithm to toy |
| `infomap` | toy + real | citation-flow-aware second opinion |
| `sparse-spectral` | toy + real | `eigsh` on sparse Laplacian |
| `kmeans-cosine` | toy | spherical k-means baseline |
| `birch-ward` | toy + real | composition: BIRCH 810k → 10k leaves → Ward |
| `dpc-knn` | toy + real | UP-DPC / ANN-DPC on sparse k-NN |
| `connected-components` | toy | trivial validator stress-test |

Each clustering entry declares its preferred input shape (raw
embedding, dim-reduced, sparse graph). The pipeline orchestrator
runs the right dim-reduction first.

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

Current real pipeline does recursive Leiden upfront (full tree to
depth 5). Two extensions:

- **`recluster_subset` operation**: takes
  `(parent_path, node_ids, params)`, emits child partition.
  Triggered on demand from the UI; doesn't require full rebuild.
- **Per-level algorithm choice**: L1 might be Leiden, L2 inside a
  focus area might be HDBSCAN (different topology assumption).
  Each level is a separate registry call. The hierarchical
  `ClusterResult` contract (§2.2) supports this without further
  changes — depth is recorded per cluster, algorithm id per
  cluster too.

This addresses the "same algorithm at every level isn't always
right" limitation the user flagged.

### 3.5 Stability metrics

Two-tier (per `clustering-research.md` §1):

**Always-visible (cheap, free)**: per-algorithm intrinsic metric.
- HDBSCAN → `relative_validity_` (DBCV) + per-cluster persistence
- Leiden → modularity Q
- Spectral → eigengap
- k-means / GMM → sampled silhouette + BIC for GMM
- Mutual k-NN → component-size distribution

**On-demand (`Validate ▾` modal)**: bootstrap-Jaccard on a fixed
50 k subsample, B = 25 reclusterings, per-cluster max-Jaccard
with Hennig thresholds (≥ 0.85 stable, 0.6–0.75 doubtful, < 0.6
not a cluster).

**Cross-algorithm disagreement** as a per-paper signal: papers
Leiden and HDBSCAN cluster differently are exactly the
"genuinely ambiguous" set worth surfacing. Free; just compute
ARI between two cluster assignments.

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

1. **Dim-reduction layer.** Build the registry, contract, and
   validator. Register `identity`, `pca`, `umap`, `pacmap`,
   `viz-umap`. Toy adopts dim-reduction as a precursor to
   clustering.
2. **Hierarchical `ClusterResult` extension.** Additive contract
   change; validator update. Register a single-level Leiden in
   the toy as the simplest hierarchical-capable test case.
3. **Recursive Leiden + per-level algorithm choice.** Implement
   `recluster_subset`; demo per-level algorithm choice on a small
   toy example.
4. **HDBSCAN on UMAP-50 in the toy.** Wire the locked default
   configuration end-to-end at toy scale. Validate via the ARI
   dim-sweep that 50-d is enough for our test data.
5. **Citation-layout for the real pipeline.** Pivot MDS per
   Leiden component (already in the layout registry). Python port
   of layout algorithms.
6. **Per-component alignment + `alignmentCorrelation` at scale.**
   `blend/align.js` ported to Python; runs against real-pipeline
   outputs. Surface correlation per cluster as a column.
7. **Per-frame blend in the scoring app.** Slider drives α;
   plotly scattergl repaints. Integration becomes user-visible.
8. **Stability metrics**: cheap always-visible per-algorithm,
   on-demand bootstrap-Jaccard `Validate ▾` modal.
9. **`doc/method-manual.md`.** Once 1–8 are stable.

Compression / subsampling for "real data in the toy" is a
parallel track, deferred.

---

## 7. Open questions to resolve as we go

Not pre-deciding these — they need data and judgment:

- **Hierarchical contract precise shape.** `nodePath` strings vs
  per-level array vs explicit tree? Decide when registering the
  first hierarchical algorithm.
- **Stopping predicate for recursion.** Leaf-size? Coherence
  threshold? Modularity gain? Depends on what the research
  questions actually need.
- **Subsample size for the toy at real-data shape.** 5 k? 10 k?
  20 k? Empirical, deferred to large-data compression work.
- **ARI dim-sweep verdict.** If `ARI(50, 100) < 0.9` on real data,
  bump default to 100-d. Currently 50-d is a defensible starting
  point.
- **`min_cluster_size` for HDBSCAN at 810 k.** 100 is a defensible
  starting point (≈ 0.01% of n); the cluster-sweep eval will
  refine on real data.
