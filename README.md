# Network Dynamics Demonstrator

An interactive 3D toy for comparing **multiple arrangements of the
same network**: a spatial embedding, a layout derived purely from
the citation topology, and — when the data carries citations — a
**fused** embedding that lets citation context reshape the topic
map before clustering. Two independent sliders blend between
endpoints deterministically, so you can ask both "do these two
views agree?" *and* "what changes when citations inform the
embedding itself?" in one interactive surface.

Built as a teaching / demo aid for network-science intuition.
Lets you ask "what does this dataset look like as positions vs. as
a graph?" and watch the answer fade between the two — then ask
"what does it look like when we fold the citation graph back into
the embedding?" and watch *that* answer too. Works on a toy
Gaussian-mixture dataset (n ≈ 400) for fast exploration, or on a
SPECTER2-embedding subset of real research papers (n = 1000+;
5000-paper BFS subset is the current load-bearing fixture).

## Running

The app is a static web page that uses ES modules, so it must be
served over HTTP (not opened as `file://`).

```bash
# from the project root
python -m http.server 8000
# open http://localhost:8000/app/
```

No build step. All dependencies (`three`, `3d-force-graph`,
`force-graph`, `umap-js`, `fflate`) load from CDNs (unpkg + esm.sh)
via an import map.

## What you do with it

The current shell is at `http://localhost:8000/app/`. The original
v3 demo shell is preserved at `http://localhost:8000/app/legacy.html`.

### Topbar: **File ▾**

Save / Save as… / Load… write or read a `.zip` archive of the
**entire project state** — every dim-reduction output, every
cluster level, every bridge analysis, every Validate / Optimise
result. Loading a saved project skips the engine cascade, so you
pick up exactly where you left off without re-running anything.

### Workflow chart (left rail)

A small SVG of the pipeline. Click any node to open its
configuration modal:

- **Data** — pick between the toy Gaussian-mixture generator and
  the real SPECTER2 paper subset (random 1000-paper or BFS-carved
  5000-paper). Real data brings its own publication years
  (`t ∈ [0, 1]` normalised over the subset's year range) and a
  citation edge list cached at ingest for the fusion stage to
  consume.
- **Dim reduce** — **five**-stage dim-reduction layer.
  1. **Noise** reduction (PCA-100).
  2. **Fusion** (optional) — citation-aware re-embedding via
     graph diffusion. Pulls papers that cite each other closer
     in feature space while keeping each anchored to its
     original SPECTER2 vector. Default identity (no fusion).
  3. **Compression** (UMAP-50, clustering input).
  4. **Viz** (UMAP-3, basePos for the 3D viewer / blend).
  5. **Viz2d** (UMAP-2, the 2D viewer's input).
  Each stage's algorithm is independent; UMAP fits get distinct
  seeds so they don't sync. When fusion is non-identity, the
  pipeline ALSO runs compression + viz on the pre-fusion data so
  the A/B comparison slider has both endpoints.
- **Clustering** — tabbed modal: **Configure**, **Optimise**,
  **Validate**. When fusion is non-identity, clustering runs
  twice (pre- and post-fusion) so the "Color by pre-fusion
  cluster" mode is available.
- **Cit. layout** — citation-driven 3D arrangement (FR, MDS, or
  UMAP-on-citation-graph). **Opt-in**: the pipeline cascade
  stops at Layer 3 and does not auto-run this layer. Open the
  modal, pick an algorithm, hit Apply. The status dot shows
  orange (stale) until you do.

Status dots on each node colour-coded fresh / stale / not-run.

### Data sources

**Toy generator** — synthetic 3-d Gaussian-mixture cloud. Knobs:
seed, node count, number of groups, group spread.

**Real (SPECTER2 dev subset)** — loads a slice of the full
SPECTER2 768-d embedding. Two carved subsets available:

- `dev_subset_1000` — random 1000-paper sample (seed 42). Useful
  as a minimal smoke fixture; citation topology is shattered
  (~3 within-subset edges).
- `dev_subset_bfs_5000` — BFS-carved 5000-paper subset (default).
  Preserves topology (~12 k within-subset edges, 100% node
  coverage). This is what fusion + UMAP-on-graph are tested on.

Both come with `paper_years.json` for `t ∈ [0, 1]` normalisation
(newest → 1, oldest → 0) and `citation_edges.json` for the
fusion stage. Toy and real are mutually exclusive — switching
modes drops the other side's state. Real mode leaves the viewers
empty by default — pick a 3-d (or 2-d) viz reduction in the
dim-reduction modal to render.

### Dim-reduction (Layer 1.5)

Five sequential / sibling sub-stages:

```
embedding ─▶ noise ─▶ fusion ─┬─▶ compression ──▶ clustering input
                              │
                              ├─▶ viz          ──▶ 3D viewer + blend
                              │
                              └─▶ viz2d        ──▶ 2D viewer
```

Each algorithm declares which sub-stages it's eligible for via a
`family` tag. Recommended defaults (clustering-research locked):

- **PCA** in noise → `n_components = 100`
- **Graph diffusion** in fusion → `alpha = 0.3, iterations = 4` (real-data only)
- **UMAP** in compression → `n_components = 50, n_neighbors = 50, min_dist = 0`
- **UMAP** in viz (3-d) → `n_components = 3, n_neighbors = 15, min_dist = 0.1`
- **UMAP** in viz2d (2-d) → `n_components = 2, n_neighbors = 15, min_dist = 0.1`

Picking an algorithm drops the user at these locked-default
values for that slot.

### Citation-aware fusion (the new stage)

Optional Layer 1.5 sub-stage. When enabled, each paper's
embedding vector is iteratively mixed with the mean of its
citation neighbours' vectors (APPNP-style anchored graph
diffusion: `X' = (1−α)X + α·D⁻¹A·X'`). The original SPECTER2
vector stays anchored at all α<1, so no paper drifts away
entirely.

Effect: downstream clustering, basePos, and the 2D viewer all
operate on a citation-informed representation. Communities that
agree across semantic and citation signals tighten; communities
that disagree may split or merge. Requires real-data mode
(citations imported at ingest); toy mode falls through as
identity because citations are generated *after* clustering
there.

### Fusion-comparison slider

When fusion is non-identity, a second slider — labelled `fusion`
— appears in the left rail under Blend. It interpolates between
**pre-fusion basePos** (UMAP-3 on the noise-stage output) and
**post-fusion basePos** (UMAP-3 on the fusion-stage output). The
two endpoints are Procrustes-aligned (whole-graph rotation + match-
RMS scale + translation) so the interpolation walks a clean
straight-line path between each node's two locations instead of
corkscrewing through arbitrary UMAP rotations.

Pair it with the **Color by pre-fusion cluster** mode in the
viewer's colour-mode dropdown to see exactly which papers were
reorganised by citation context — colours stay constant (defined
by pre-fusion clusters), positions drift.

### Multi-level clustering

The Clustering modal's **Configure** tab supports a stack of
clustering levels. Each level has its own params; non-root levels
also have a scope toggle:

- **global** — re-cluster the whole dataset at this level's
  params (often a finer resolution).
- **within parent** — run the algorithm within each previous-
  level cluster's members only.

Mix freely. Add levels with **+ Add level**, remove with **×**.
Same algorithm shared across all levels.

### Optimise tab

Sweep `algorithms × parameters` and rank by a chosen scorer:

- **Match to known groups** — ARI vs the toy generator's
  ground-truth origins. Toy-only.
- **Cluster richness** — `cluster count × bootstrap
  reproducibility`. Balanced — penalises both noise-fragmented
  and trivially-coarse partitions. Default for real data.
- **Number of clusters** — raw count. Use when you trust the
  algorithm and want to push toward more clusters.
- **Cluster reproducibility** — Hennig bootstrap-Jaccard
  fraction-stable. Beware: over-rewards trivial partitions.

Two sweep depths: **Resolution only** (just the parameters that
control granularity — fast) or **Full grid** (every parameter,
much slower).

Results table shows every config swept, **sortable columns**, with
per-row **Apply** that commits the config and hops to the
Validate tab.

### Validate tab

Bootstrap-Jaccard on the currently-applied clustering. Per-
cluster stability scores with Hennig thresholds (stable ≥ 0.85,
doubtful 0.60–0.85, unstable < 0.60). Click a row to select that
cluster in the viewers.

### Bridge analysis (Layer 2.5)

When ≥ 2 clustering levels exist, the toy automatically computes,
for any chosen `(fineLevel, coarseLevel)` pair, each fine
cluster's share breakdown against every coarser level. Surfaces
as `bridge` and `boundaryScore` colour modes in both viewers and
as `bridge` / `boundaryScore` sources in the node table (with the
fine / coarse level-pair selector + per-level share columns).

### 3D viewer (primary panel)

Live blend visualisation. Top-left: **Colour by:** dropdown
selects what drives node colour (cluster level, origin, time,
in-degree, bridge, boundary score). Top-right: **⚙** opens
camera-speed settings.

### 2D viewer panel

Canvas-based 2D scatter. Same colour-by dropdown, same colour
rules as the 3D viewer (shared resolver under the hood). Reads a
separate 2-d basePos from the viz2d sub-stage. Add it via the
`+` button on any panel slot. Stays empty until viz2d has run.

### Node table (legend)

A mode-aware table that doubles as the legend for whatever's
colouring the viewers. Source dropdown: **Auto** follows the
viewer's colour mode, or pin to a specific source. Continuous
gradients display a min↔max gradient bar.

### Blend slider (left rail bottom)

Sweeps `α: 0 → 1`. At α=0 you see the embedding (basePos); at
α=1 you see the citation-driven layout (per-component aligned to
basePos so the two views share scale/orientation); in between is
a per-frame linear interpolation. **Inert until you explicitly
apply a Citation Layout algorithm** — the cascade no longer
auto-runs that layer.

When fusion is non-identity, a second `fusion` row appears with
its own slider; the two compose as a nested lerp inside the
blend hook. The four corners of `(fusion, α)`-space are:

|              | α=0                          | α=1                                   |
|--------------|------------------------------|---------------------------------------|
| fusion=0     | pre-fusion semantic basePos  | citation layout aligned to pre-fusion |
| fusion=1     | post-fusion (citation-aware) | citation layout aligned to post-fusion|

Round-trip is exact for each slider independently. 3D-only.

### Multi-tab panels

Every slot — primary, secondary, bottom — has tabs. Click `+` to
add a new panel via a picker modal listing all registered panel
types. `×` on a tab closes it. The 3D viewer, 2D viewer are
singletons (one each). Other types can have multiple instances.

## Architecture

Six-layer pipeline of pure functions. Each layer takes the
previous layer's public contract and produces its own — adding
a new algorithm is one new entry in the relevant registry, no
other file changes needed.

```
datasource/registry.js        Layer 1    pluggable data source
                                          → {nodes, origins?, embedding?, basePos?, citationEdges?}
        ↓
dimred/registry.js            Layer 1.5  five-stage dim-reduction
                                          noise → fusion → (compression, viz, viz2d)
                                          → dimredResult (+ dimredResultPreFusion)
                                          → _basePos     (+ _basePosPreFusion)
                                          → _basePos2d
        ↓
clustering-registry.js        Layer 2    pluggable clustering (mutual k-NN, HDBSCAN, CC)
                                          → ClusterResult contract (multi-level)
                                          → clusterLevelsPreFusion (when fusion active)
        ↓
citations/registry.js         Layer 3    taste-network (toy) or imported-edges (real)
                                          → CitationResult contract
        ↓                                 CASCADE STOPS HERE (citation layout is opt-in)
citation-layout/registry.js   Layer 4    citation-driven 3D arrangement (FR / MDS / UMAP-on-graph)
        ↓                                 user explicitly applies via the Citation Layout modal
blend/align.js                Layer 5a   similarity alignment:
                                          alignByComponent — per-component, citation → basePos
                                          alignGlobal      — whole-graph, preFusion → postFusion
                                          → alignedCitationLayout + alignmentCorrelation
blend/blend.js                Layer 5b   per-frame nested lerp:
                                          effective = lerp(preFusion, postFusion, fusionBlend)
                                          live      = lerp(effective, alignedCitation, blend)
```

Math reference for each layer is in `doc/`. Start with
`doc/dynamics.md` for the index.

Doc highlights:
- `doc/dimred.md` — Layer 1.5 sub-stages, registry contract, engine orchestration, slot-aware defaults
- `doc/fusion.md` — Layer 1.5 fusion sub-stage: graph-diffusion algorithm, fusion-comparison slider, pre-fusion cluster colour mode, A/B comparison semantics
- `doc/clustering.md` — Layer 2 contract + algorithms
- `doc/citations.md` — Layer 3 contract + taste-network (toy) + imported-edges (real)
- `doc/citation-layout.md` — Layer 4 algorithms (FR, MDS / SMACOF, UMAP-on-graph) + which to pick at which scale
- `doc/blend.md` — Layer 5 alignment + per-frame blend; covers per-component vs whole-graph (alignGlobal) Procrustes, the nested-lerp formula, and the opt-in cascade policy
- `doc/multi-level.md` — multi-level clustering + bridge analysis derivation
- `doc/ui-architecture.md` — the new shell's state container, engine orchestrator, workflow chart, panel system, modals
- `doc/scaling.md` — toy-vs-real-data scaling analysis (`n ≈ 400` toy, `n = 810 k` real)
- `doc/clustering-research.md` — research record, per-family pros/cons, locked picks, stability metrics
- `doc/plan.md` — convergence plan with status flags

## File layout

```
app/                              static page + ES modules
  index.html                      importmap + boot
  legacy.html                     v3-stage-X archive shell
  styles/main.css
  src/
    rng.js                        shared seeded PRNG (mulberry32 + Box-Muller)
    generation.js                 toy Gaussian-mixture generator
    datasource/                   Layer 1 — pluggable data source
      registry.js
      contract.js
      toy.js                      wraps generation.js
      real.js                     fetches SPECTER2 dev_subset .npy
    dimred/                       Layer 1.5 — pluggable dim-reduction
      registry.js
      contract.js
      identity.js
      pca.js
      umap.js                     wraps umap-js
      graph-diffusion.js          fusion stage — APPNP-style citation-aware re-embedding
    clustering-registry.js        Layer 2 dispatcher
    clustering.js                 L2: mutual k-NN
    clustering-hdbscan.js         L2: HDBSCAN
    clustering-cc.js              L2: connected components
    citations/                    Layer 3
      registry.js
      contract.js
      taste-network.js            L3: toy synthetic citation generator
      imported-edges.js           L3: real-data citation importer (consumes state.rawCitationEdges)
      importers/
        registry.js
        json-file.js              fetches literture-network/artifacts/<subset>/citation_edges.json
    neighbourhoods.js             taste-network's stage 1
    citation-taste.js             taste-network's stages 2 + 3
    citations.js                  taste-network's stage 4
    base-edges.js                 visual base-edge selection
    citation-layout/              Layer 4
      registry.js
      contract.js
      fr.js                       L4: Fruchterman–Reingold
      mds.js                      L4: MDS / SMACOF
      umap-graph.js               L4: UMAP on the citation graph (precomputed k-NN)
    blend/                        Layer 5
      align.js                    L5a: alignByComponent + alignGlobal (Procrustes)
      blend.js                    L5b: per-frame nested lerp (blend × fusionBlend)
    eval/                         bootstrap-Jaccard + cross-algo sweep
      jaccard.js
      bootstrap.js
      scorers.js                  ari / stability / numClusters / richness
      sweep.js                    sweepAcrossAlgorithms
      ari.js, kmeans.js           legacy eval helpers
      layout-sweep.js             legacy citation-layout sweep
    contracts/
      cluster.js                  ClusterResult validator
    persistence/                  .zip save/load
      manifest.js                 SCHEMA_VERSION
      serialise.js
      deserialise.js
    ui/                           new shell
      main.js                     boot
      state.js                    state container + actions
      engine.js                   pipeline orchestrator (async reingest)
      workflow-chart.js
      panel-system.js
      data-panel.js
      topbar.js                   File / Data / Workflow / Validate / Help menus
      bridge-analysis.js
      gradients.js
      viewer-shared/
        colour-modes.js           shared colour resolver for both viewers
      panels/
        registry.js
        viewer-3d.js              3d-force-graph
        viewer-2d.js              force-graph (canvas-based)
        node-table.js
        placeholder.js
      modals/
        modal.js
        algorithm-modal.js
        clustering-modal.js       tabbed Configure / Optimise / Validate
        clustering-tabs/
          configure-tab.js
          optimise-tab.js
          validate-tab.js
        dimred-modal.js           five-stage (noise / fusion / compression / viz / viz2d)
        data-source-modal.js
        panel-picker.js
        layer-descriptors.js
    main.js                       legacy boot + UI glue (drives legacy.html)
literture-network/                real-data pipeline (Python)
  artifacts/
    expanded_embeddings.npy       full SPECTER2 (810 k × 768)
    dev_subset/                   1000-paper random subset
      expanded_embeddings.npy     subset embedding (n × 768, float32)
      expanded_embeddings_paper_index.json   row → paper_id
      paper_years.json            row → publication year (drives node.t)
      citation_edges.json         induced citation-edge subgraph (carved separately)
      subset_meta.json            provenance (seed, indices_into_source, …)
    dev_subset_bfs/               5000-paper BFS-carved subset (default real-mode fixture)
      (same shape as dev_subset; ~12 k edges, 100% node coverage, years 1954–2026)
  citgraphv2/output/
    edges.csv                     raw directed citation network
    nodes.csv                     paper metadata (includes `year` column)
  scripts/
    make_dev_subset.py            carve random embedding subset (+ paper_years.json)
    make_dev_subset_bfs.py        carve BFS connectivity-aware subset (+ paper_years.json)
    make_subset_citation_edges.py carve induced citation-edge subgraph for a subset
doc/
  dynamics.md                     layer index
  clustering.md, citations.md, citation-layout.md, blend.md
  multi-level.md                  multi-level clustering + bridge analysis
  ui-architecture.md
  scaling.md
  clustering-research.md
  plan.md
```

## Branches

- `main` — historical v1 (original spring force).
- `v2` — adds HDBSCAN clustering and the cluster-eval modal;
  still uses the spring / PBD layout solver. Final v2 commit is
  `v2 stage 6: PBD layout solver replacing spring physics`.
- `v3` — current. Replaces the constraint solver entirely with
  deterministic blend between precomputed arrangements, adds
  MDS + UMAP-on-citation-graph as additional layout algorithms,
  adds the alignment-correlation metric and cross-algorithm
  layout sweep, plus all the slices documented in `doc/plan.md`
  (multi-level clustering, bridge analysis, data-source +
  dim-reduction layers, two viewers, save/load, optimisation +
  validation, citation-aware embedding fusion + comparison
  slider, opt-in citation layout).
