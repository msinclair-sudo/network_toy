# Clustering — research and decisions

This doc records (a) the locked clustering picks for the integrated
tool and (b) the research that justifies them. Pairs with
`doc/plan.md`, which is the build spec. If a method appears here
but not in plan.md, it's research context — we considered it and
chose not to register it.

The research was a four-thread literature sweep (May 2026): per-
family pros/cons (density / partition / graph / spectral / deep),
stability metrics, SPECTER2-specific embedding properties,
dim-reduction tradeoffs, HDBSCAN best practices. Sources at the end.

---

## 1. Locked decisions (summary)

### Dim-reduction stage (new Layer 1.5)

| ID | Algorithm | Default | Role |
|----|-----------|---------|------|
| `identity` | no-op | — | toy debugging; preserves embedding as-is |
| `pca` | PCA | `n_components=100` | denoiser before UMAP; cheap baseline alone |
| `umap` | UMAP | `n_components=50, n_neighbors=50, min_dist=0, init='pca', metric='cosine', random_state=42` | **default for clustering** |
| `pacmap` | PaCMAP | `n_components=50, MN_ratio=0.5` | alternative; preserves both local + global; faster |
| `viz-umap` | UMAP | `n_components=3, n_neighbors=15, min_dist=0.1` | **toy visualisation only** — separate fit, never used for clustering |

### Clustering algorithms (registry)

| ID | Algorithm | Role |
|----|-----------|------|
| `hdbscan` | HDBSCAN on UMAP-50 | **default for the toy + alternative for real pipeline**; density valleys + noise concept |
| `leiden-cpm` | Leiden CPM (single-level) | graph backbone; baseline for recursive |
| `leiden-recursive` | Recursive Leiden CPM | **default for real pipeline**; research focus targets |
| `infomap` | Infomap | citation-flow-aware second opinion; native hierarchy |
| `mutual-knn` | Mutual k-NN connected components | noise pre-filter; complement to Leiden |
| `sparse-spectral` | sparse-Laplacian spectral via `eigsh` | non-modularity, non-density alternative |
| `kmeans-cosine` | spherical k-means | toy baseline + cluster-sweep eval |
| `birch-ward` | BIRCH → Ward agglomerative | hierarchical alternative; scales via composition |
| `dpc-knn` | Density Peak on sparse k-NN (UP-DPC / ANN-DPC) | interpretable ρ/δ centres |
| `connected-components` | Connected components | trivial validator stress-test |

### Stability metrics (two-tier)

- **Always-visible (cheap, free)**: per-algorithm intrinsic metric
  surfaced under one column header — `relative_validity_` for
  HDBSCAN, modularity Q for Leiden / Louvain, eigengap for
  spectral, sampled silhouette for k-means/GMM, component-size
  distribution for mutual k-NN.
- **On-demand (Validate ▾ modal)**: bootstrap-Jaccard on a fixed
  50 k subsample, B = 25 reclusterings, per-cluster max-Jaccard
  with Hennig thresholds (≥ 0.85 stable, 0.6–0.75 doubtful, < 0.6
  not a cluster).
- **Cross-algorithm disagreement** as a per-paper signal: papers
  Leiden and HDBSCAN cluster differently are exactly the
  "we don't know" set.

### Validation move: ARI dim-sweep

To verify "no information lost" through dim-reduction, run the
same clustering pipeline at UMAP-target-dim ∈ {30, 50, 100, 200}
and compute ARI between resulting partitions. Threshold:
`ARI(50, 100) > 0.9` confirms 50-d isn't costing accuracy on
*this* corpus. Extends `app/src/eval/sweep.js`.

---

## 2. Why these picks

### 2.1 SPECTER2 embedding properties

SPECTER2 is a 768-d citation-trained contrastive embedding from
AllenAI (Singh et al. 2023), fine-tuned from SciBERT on ~6M citation
triplets across 23 fields. Trained for L2 on `[CLS]`; cosine works
because most users L2-normalise first.

Three properties drive every downstream choice:

- **Anisotropy ("cone effect")**: like all BERT-family `[CLS]`
  spaces, embeddings collapse into a narrow cone in 768-d. The
  *effective* dimensionality is well below 768; raw Euclidean
  distances compress. **Implication**: L2-normalise + cosine is
  non-negotiable; raw Euclidean k-NN is misleading.
- **Hubness**: a few papers become k-NN of disproportionately many
  others (a transformer-output pathology). Mutual-k-NN partly
  mitigates; doesn't eliminate. **Implication**: pre-reduce or
  use mutual-k-NN explicitly.
- **What it preserves**: domain/field separation (by construction
  — 23 training fields), citation-neighbourhood structure (the
  training signal), title+abstract semantic content. **Doesn't
  preserve**: temporal drift, methodology vs topic, fine-grained
  sub-disciplinary boundaries within one field.

The dominant pipeline at ~10⁶+ paper scale is **UMAP → HDBSCAN**
(BERTopic-style). 21M-PubMed map and 10M-paper-map projects both
use this exact recipe. Direct k-means in 768-d is documented to
fail from the curse of dimensionality regardless of encoder.

### 2.2 Dim reduction: UMAP-100 doesn't trade accuracy for compression

> **2026-05-25 update (§6.9 dim-sweep validation):** the original
> default was UMAP-50 per the literature surveyed below. Empirical
> validation on the BFS-5000 fixture found `ARI(50, 100) = 0.806`
> — below the 0.9 threshold for "50-d preserves enough information."
> `ARI(100, 200) = 1.000` exactly, so 100 is the saturation point:
> below loses clustering structure, above is wasted compute.
> Default bumped 50 → 100. See `doc/dim-sweep-results.md` for the
> full protocol + table. The original literature-led narrative
> below is preserved; the 50-d figure was the right starting hypothesis
> from prior work, but our specific corpus + clustering combination
> wanted more dimensions.

The "don't trade accuracy" anxiety is real and legitimate, but it
applies to UMAP-to-2-d (visualisation), not UMAP-to-50-d
(clustering preprocessor). Specifically:

- **Chari & Pachter (PLOS Comp Bio 2023)** critiqued 2-d UMAP as
  analytic ground truth — fabricated boundaries, distance
  distortion. They showed an autoencoder can fit data to an
  elephant shape with comparable distortion to UMAP-2d.
- **Lause / Berens / Kobak (PLOS Comp Bio 2024)** rebutted: the
  original metrics were inadequate. UMAP / t-SNE preserve k-NN-
  class purity even when they distort distances. **The information-
  loss phase transition is between 2-d and ~10-d, not between 50-d
  and 768-d.**
- **Working consensus** (BERTopic best practices, UMAP authors,
  multiple 2024-25 SBERT-clustering papers): 2-d for plots, 10–50-d
  for clustering. Going from 50-d to 100-d gives diminishing
  returns; going from 5-d to 50-d is large.
- **PCA alone fails**: GDELT measured PCA-50 → HDBSCAN dumping
  nearly all points into noise on USEv4 sentence embeddings;
  UMAP-50 → HDBSCAN clustered cleanly on the same data. PCA
  preserves variance, not cluster boundaries on transformer
  embeddings. PCA's right role is a *denoiser prefix* before UMAP.
- **Clustering directly in 768-d also fails**: 2024 SPECTER+SciNCL
  evaluation reported "too few clusters and many noise points,
  negligible ARI/NMI" running HDBSCAN directly on full embeddings.
  Anisotropy + hubness break density estimation.

**PaCMAP** (Wang et al., JMLR 2021) registers as the alternative:
preserves both local and global structure under perturbation
without needing PCA initialisation, faster than UMAP (8.4 s vs
24 s on benchmarks). 2024-25 reproductions confirm. Worth
registering for cross-checking; not strictly necessary for the
default path.

The **ARI dim-sweep** (§1.4) is the empirical version of the
Chari/Pachter test, applied where it matters: cluster-assignment
ARI at varying UMAP target dims, on *our* data. Above the 0.9
threshold, the 50-d choice is empirically defensible. Below, bump
to 100-d.

### 2.3 Clustering: HDBSCAN + Leiden as complementary

The decision is **register both as alternatives**, not one as a
replacement for the other. Each catches what the other misses:

- **HDBSCAN** (on UMAP-50): finds density valleys; emits a noise
  label that is honest "this paper isn't in any dense region" —
  the noise concept Leiden refuses to provide. Per-cluster
  persistence is a free stability score (excess of mass).
- **Leiden CPM** (on the hybrid graph): scales to 14M-node networks
  in benchmarks, the only modularity-family algorithm with
  connectivity guarantees + recursive support via local γ
  threshold. Currently in production.
- **Disagreement between them is the per-paper confidence signal**
  — a paper Leiden and HDBSCAN cluster differently is exactly the
  "this is genuinely ambiguous" set. Cheaper than bootstrap-
  Jaccard and provides per-paper granularity.

**Why HDBSCAN doesn't replace Leiden**: 2024 community-detection
benchmark (Pankratz et al., Oxford) found Leiden on graph-supported
embeddings dominates HDBSCAN. 2024 SPECTER evaluation found
k-means/GMM beat HDBSCAN on paper-category identification. HDBSCAN's
strength is variable-density clusters in a continuous embedding;
Leiden's strength is community structure in a graph. Both are real;
neither is universal.

**Why the additional registrations**:

- **Infomap**: information-theoretic, flow-based — operates on
  citation flow rather than density. Native hierarchy. Disagreement
  vs Leiden on the same graph is a direct stability signal that
  Leiden alone can't provide.
- **Mutual k-NN connected components**: gives Leiden the noise
  concept it lacks. Pre-filter that drops poorly-connected papers
  before Leiden runs on the giant component.
- **Sparse-Laplacian spectral**: non-modularity, non-density
  third option. Surfaces structure both Leiden and HDBSCAN miss
  when it exists.
- **BIRCH → Ward**: the composition pattern that makes
  vanilla-infeasible methods scale. BIRCH compresses 810 k → 10 k
  CF leaves; Ward on 10 k is trivial. Gives a true Ward dendrogram
  distinct from recursive Leiden's tree.
- **DPC on sparse k-NN** (UP-DPC / ANN-DPC variants): interpretable
  ρ/δ decision graph; family no other registered method represents.
- **Spherical k-means**: registered as a baseline for the toy's
  cluster-sweep eval. Useful for teaching.
- **Connected components**: trivial baseline for testing the
  hierarchical contract validator.

### 2.4 Stability: two-tier metric strategy

The constraint set — no ground truth, n ≈ 810 k, mixed algorithm
zoo — rules out most elegant options. Bootstrap-Jaccard at 25
reclusterings × Leiden at 810 k = hours. Not a per-frame UI metric.

Two-tier resolves this:

- **Cheap, always-visible** (one column): per-algorithm intrinsic
  score. Each chosen algorithm has a free quality metric — DBCV
  for HDBSCAN, modularity for Leiden, eigengap for spectral,
  silhouette for k-means/GMM. Mirror the `alignmentCorrelation`
  pattern from the layout layer.
- **Expensive, on-demand**: bootstrap-Jaccard on a fixed 50 k
  subsample. Hennig's thresholds are interpretable (≥ 0.85
  stable, 0.6–0.75 doubtful, < 0.6 not a cluster). Surfaced in
  a `Validate ▾` modal as per-cluster bar chart.

ARI / NMI / V-measure are unavailable for runtime confidence (no
ground truth). They remain useful for *comparing* two clusterings
(e.g., Leiden vs HDBSCAN on the same data), which is the
"disagreement" signal in §2.3.

---

## 3. Methods considered but not registered

For each: 1–2 lines on why we skipped it. The first eight are
fundamentally incompatible with SPECTER2 or strictly dominated by
a registered alternative; the last four are scaling rule-outs at
810 k.

| Method | Why not |
|--------|---------|
| **Mean-shift** | KDE in 768-d is statistically broken; bandwidth selection is ill-posed regardless of runtime. No engineering fixes this. |
| **Full-covariance GMM** | 768² = 590 k parameters per component; covariances go singular. Diagonal-covariance is fine and registered as part of k-means / GMM family if needed. |
| **CLIQUE / SUBCLU / PROCLUS** | Axis-parallel subspace assumption is wrong for transformer embeddings — SPECTER2 axes are arbitrary linear combos from the projection head, not interpretable features. |
| **SSC / LRSC** | Union-of-linear-subspaces premise violated by SPECTER2's curved manifold. SSC-OMP / EnSC scale, but the assumption mismatch persists. |
| **ORCLUS** | Rotated-subspace cousin of PROCLUS; better fit in theory but same curved-manifold mismatch in practice; ~10⁵ ceiling. |
| **DEC / IDEC / VaDE / SwAV** | Joint encoder + clustering retraining. SPECTER2 is *already* trained with citation prediction as its self-supervised signal; re-training the encoder is technical debt for marginal lift, and these methods have well-documented mode collapse / posterior collapse / seed variance. |
| **Walktrap** | O(n²) memory makes vanilla impossible; block-Walktrap exists in research code but is strictly dominated by Infomap (also random-walk-based, scales, production-grade library). |
| **Louvain** | Strictly dominated by Leiden — no connectivity guarantee, modularity resolution limit, produces disconnected communities in up to 25% of runs. |
| **OPTICS** | Strictly dominated by HDBSCAN at this scale — no production GPU port, O(n²) in sklearn, parameter-sensitive xi-extraction, weaker stability story. |
| **Affinity Propagation** | O(n²) memory at 810 k = ~2.6 TB. Sparse-AP variants exist but published ceiling is ~100 k. Toy-only at best. |
| **t-SNE for clustering** | Local structure only; less global preservation than UMAP/PaCMAP at clustering-target dims. González-Márquez 2023 reported it beat UMAP on 21M-PubMed-paper fine clustering, but the result is contested and PaCMAP is now the better choice if local preservation matters. |
| **Direct k-NN clustering on raw 768-d** | Anisotropy + hubness skew the k-NN graph. Mutual-k-NN partly mitigates but doesn't eliminate. The path is dim-reduce first, then cluster. |

---

## 4. Configuration reference (the locked path)

For 810 k SPECTER2 papers, the default pipeline:

```
1. L2-normalise the 768-d vectors
   (cheap; required for cosine ↔ Euclidean equivalence)

2. PCA → 100 components
   (>95% variance retained for BERT-class embeddings; denoiser)

3. UMAP → 50 components for clustering
   n_components=50         (NOT 5 — BERTopic's 5 is a viz compromise)
   n_neighbors=50          (large for global structure at this scale)
   min_dist=0.0            (tight clusters, not viz spread)
   metric='cosine'
   init='pca'              (default in umap-learn ≥ 0.5)
   low_memory=True         (required at 810 k)
   random_state=42         (UMAP is stochastic — pin and version-pin umap-learn)

4. HDBSCAN on UMAP-50 output
   min_cluster_size=100         (≈ 0.01% of n; raise for fewer/coarser)
   min_samples=10               (decoupled from min_cluster_size — suppresses noise without coarsening)
   cluster_selection_method='eom'   (or 'leaf' for fine subfields)
   metric='euclidean'           (cosine is folded into UMAP already)
   prediction_data=True         (enables soft reassignment)

5. Soft-reassign noise points
   approximate_predict / BERTopic.reduce_outliers
   (50% noise is a documented BERTopic problem; this is the standard fix)

6. SEPARATE UMAP fit → 3 components for the toy's blend slider VIZ
   n_components=3
   n_neighbors=15
   min_dist=0.1
   random_state distinct from clustering UMAP
   NEVER used for clustering
```

**Library**: `cuML` for HDBSCAN + UMAP at scale (~175× speedup vs CPU; reported 400 k docs → < 2 s for soft clustering, 3 M × 300-d → ~22.8 min on a DGX-1). Pure-CPU `umap-learn` is feasible (~hours) for testing.

**Versioning**: pin `umap-learn`, `hdbscan`, `cuml` versions; store
the reduced embedding (don't recompute) since UMAP is stochastic.

---

## 5. Stability and confidence metrics — full reference

The stability research thread surveyed four families. Headline below; full notes from the May 2026 sweep retained for reference.

### A. Internal validity (no GT, no perturbation)

| Metric | Best for | Cost at 810 k |
|--------|----------|---------------|
| Sampled silhouette | convex / globular clusters | sampled (~10–20 k) — seconds |
| Davies–Bouldin | k-means / GMM | O(n·k) — trivial |
| Calinski–Harabasz | k-means / GMM, fast | O(n) — trivial |
| **DBCV** (Moulavi 2014) | density / arbitrary-shape | HDBSCAN's `relative_validity_` is O(n log n) approximation |

DBCV via `relative_validity_` is the only widely-accepted internal
index that scores HDBSCAN/DBSCAN/OPTICS honestly — Silhouette / DB
/ CH are biased toward globular geometry and mislead on density
clusters.

### B. External agreement (compare two partitions)

| Metric | Use |
|--------|-----|
| **ARI** | chance-corrected, symmetric, [-1, 1]; the right metric for "do these two clusterings agree" |
| AMI | chance-corrected MI; use when k differs between partitions |
| FMI / V-measure | bounded, decomposable; less common |

No ground truth at scale, so this category is **only useful for
the disagreement signal** between Leiden and HDBSCAN on the same
data.

### C. Stability via perturbation

| Metric | Why we picked it (or didn't) |
|--------|-------------------------------|
| **Bootstrap-Jaccard** (Hennig 2007) | Picked for the on-demand `Validate ▾` modal. Clear thresholds, per-cluster scores, algorithm-agnostic. B = 25 × 50 k subsample fits in minutes. |
| Prediction strength | Centroid-based; awkward for HDBSCAN. Skip. |
| CHAMP | Modularity-only; useful but graph-specific. Optional addition for Leiden. |
| Consensus clustering | O(n²) consensus matrix at 810 k = 2.6 TB. Skip. |

### D. Algorithm-specific intrinsic scores (free)

| Metric | Algorithm | When surfaced |
|--------|-----------|---------------|
| `relative_validity_` (DBCV) + per-cluster persistence | HDBSCAN | always-visible |
| Modularity Q | Leiden / Louvain | always-visible |
| Eigengap | Spectral | always-visible |
| Sampled silhouette | k-means / GMM | always-visible |
| BIC / AIC | GMM | optional |
| Component-size distribution | mutual k-NN | always-visible (built-in noise signal) |

Each is **free** — already computed during the algorithm run.

---

## 6. Sources

### SPECTER2 + embedding properties

- [SPECTER2 model card](https://huggingface.co/allenai/specter2)
- [SPECTER2 — AllenAI blog](https://allenai.org/blog/specter2-adapting-scientific-document-embeddings-to-multiple-fields-and-task-formats-c95686c06567)
- [SciRepEval (Singh et al., EMNLP 2023)](https://aclanthology.org/2023.emnlp-main.338/)
- [SPECTER (Cohan et al., ACL 2020)](https://aclanthology.org/2020.acl-main.207.pdf)
- [SciNCL (EMNLP 2022)](https://aclanthology.org/2022.emnlp-main.802.pdf)
- [Is Anisotropy Really the Cause of BERT Embeddings not Being Semantic?](https://aclanthology.org/2022.findings-emnlp.314.pdf)
- [Stable Anisotropic Regularization (ICLR 2024)](https://openreview.net/pdf?id=dbQH9AOVd5)
- [10M-paper interactive semantic map](https://github.com/huangyan28/paper_map)

### Dim reduction

- [The specious art of single-cell genomics — Chari & Pachter, PLOS Comp Bio 2023](https://journals.plos.org/ploscompbiol/article?id=10.1371%2Fjournal.pcbi.1011288)
- [The art of seeing the elephant — Lause/Berens/Kobak rebuttal, PLOS Comp Bio 2024](https://journals.plos.org/ploscompbiol/article?id=10.1371%2Fjournal.pcbi.1012403)
- [Initialization is critical — Kobak & Linderman, Nat Biotech 2021](https://www.nature.com/articles/s41587-020-00809-z)
- [PaCMAP (JMLR 2021)](https://jmlr.org/papers/volume22/20-1061/20-1061.pdf)
- [GDELT: PCA vs UMAP for HDBSCAN preprocessing](https://blog.gdeltproject.org/visualizing-an-entire-day-of-global-news-coverage-technical-experiments-pca-vs-umap-for-hdbscan-t-sne-dimensionality-reduction/)
- [BERTopic best practices](https://maartengr.github.io/BERTopic/getting_started/best_practices/best_practices.html)
- [UMAP for clustering (umap-learn docs)](https://umap-learn.readthedocs.io/en/latest/clustering.html)
- [Considerably Improving Clustering Algorithms Using UMAP — PMC 2020](https://pmc.ncbi.nlm.nih.gov/articles/PMC7340901/)

### HDBSCAN at scale

- [HDBSCAN parameter selection](https://hdbscan.readthedocs.io/en/latest/parameter_selection.html)
- [BERTopic clustering](https://maartengr.github.io/BERTopic/getting_started/clustering/clustering.html)
- [BERTopic outlier reduction](https://maartengr.github.io/BERTopic/getting_started/outlier_reduction/outlier_reduction.html)
- [Faster HDBSCAN Soft Clustering with RAPIDS cuML](https://developer.nvidia.com/blog/faster-hdbscan-soft-clustering-with-rapids-cuml/)
- [GPU-Accelerated Hierarchical DBSCAN with RAPIDS cuML](https://developer.nvidia.com/blog/gpu-accelerated-hierarchical-dbscan-with-rapids-cuml-lets-get-back-to-the-future/)

### Graph / community detection

- [From Louvain to Leiden — Traag et al., Sci. Reports 2019](https://www.nature.com/articles/s41598-019-41695-z)
- [Community Detection with Map Equation and Infomap (ACM CSUR 2024)](https://dl.acm.org/doi/10.1145/3779648)
- [Performance of community detection supported by node embeddings — Pankratz et al., Oxford 2024](https://academic.oup.com/comnet/article/12/4/cnae035/7736903)
- [Comprehensive review of community detection (Neurocomputing 2024)](https://arxiv.org/pdf/2309.11798)

### Spectral / hybrid scaling

- [Comprehensive Survey on Spectral Clustering with GSL (arXiv 2501.13597)](https://arxiv.org/abs/2501.13597)
- [Density Peak Clustering review 2014–2023](https://www.sciencedirect.com/science/article/pii/S095741742302362X)

### Stability metrics

- [PeerJ 2024 — Silhouette/DB more informative than Dunn/CH](https://peerj.com/articles/cs-3309/)
- [Moulavi et al. — DBCV (SIAM 2014)](https://epubs.siam.org/doi/pdf/10.1137/1.9781611973440.96)
- [HDBSCAN `relative_validity_`](https://hdbscan.readthedocs.io/en/latest/api.html)
- [Hennig — cluster-wise assessment of cluster stability](https://www.homepages.ucl.ac.uk/~ucakche/papers/clusta.pdf)
- [Liu et al. — Stability estimation review (WIREs 2022)](https://wires.onlinelibrary.wiley.com/doi/10.1002/wics.1575)

### Rejected-method citations (reference only)

- [DEC (arXiv 1511.06335)](https://arxiv.org/abs/1511.06335)
- [VaDE (arXiv 1611.05148)](https://arxiv.org/abs/1611.05148)
- [SSC (arXiv 1203.1005)](https://arxiv.org/abs/1203.1005)
- [Subspace Clustering for High-Dim Data — Parsons et al., KDD](https://www.kdd.org/exploration_files/parsons.pdf)
