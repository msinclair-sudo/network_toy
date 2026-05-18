# Network Dynamics Demonstrator

An interactive 3D toy for comparing **two arrangements of the same
network**: the spatial embedding nodes are generated from, vs. a
layout derived purely from the citation topology between them. A
single slider blends between them — α=0 is the embedding, α=1 is
the citation-driven arrangement, anything in between is a smooth
deterministic interpolation.

Built as a teaching / demo aid for network-science intuition.
Lets you ask "what does this dataset look like as positions vs. as
a graph?" and watch the answer fade between the two. Works on a
toy Gaussian-mixture dataset (n ≈ 400) for fast exploration, or on
a SPECTER2-embedding subset of real research papers (n = 1000+).

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
  the real SPECTER2 paper subset.
- **Dim reduce** — four-stage dim-reduction layer. Noise
  reduction (PCA), dimension compression (UMAP-50, clustering
  input), 3D visualisation reduction (UMAP-3, basePos), 2D
  visualisation reduction (UMAP-2, the 2D viewer's input). All
  four are independent fits with their own seeds.
- **Clustering** — tabbed modal: **Configure**, **Optimise**,
  **Validate**.
- **Cit. layout** — citation-driven 3D arrangement (FR or MDS).

Status dots on each node colour-coded fresh / stale / not-run.

### Data sources

**Toy generator** — synthetic 3-d Gaussian-mixture cloud. Knobs:
seed, node count, number of groups, group spread.

**Real (SPECTER2 dev subset)** — loads a 1000-paper slice of the
full SPECTER2 768-d embedding from
`literture-network/artifacts/dev_subset/`. Toy and real are
mutually exclusive — switching modes drops the other side's
state. Real mode leaves the viewers empty by default — pick a
3-d (or 2-d) viz reduction in the dim-reduction modal to render.

### Dim-reduction (Layer 1.5)

Four sequential / sibling sub-stages:

```
embedding ─▶ noise ─┬─▶ compression ──▶ clustering input
                    │
                    ├─▶ viz          ──▶ 3D viewer + blend
                    │
                    └─▶ viz2d        ──▶ 2D viewer
```

Each algorithm declares which sub-stages it's eligible for via a
`family` tag. Recommended defaults (clustering-research locked):

- **PCA** in noise → `n_components = 100`
- **UMAP** in compression → `n_components = 50, n_neighbors = 50, min_dist = 0`
- **UMAP** in viz (3-d) → `n_components = 3, n_neighbors = 15, min_dist = 0.1`
- **UMAP** in viz2d (2-d) → `n_components = 2, n_neighbors = 15, min_dist = 0.1`

Picking an algorithm drops the user at these locked-default
values for that slot.

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

Sweeps `α: 0 → 1`. At α=0 you see the embedding; at α=1 you see
the citation-driven layout (per-component aligned so the two
views share scale/orientation); in between is a per-frame linear
interpolation. Round-trip is exact. 3D-only feature.

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
                                          → {nodes, origins?, embedding?, basePos?}
        ↓
dimred/registry.js            Layer 1.5  four-stage dim-reduction
                                          → dimredResult (clustering input)
                                          → _basePos     (3D viewer / blend)
                                          → _basePos2d   (2D viewer)
        ↓
clustering-registry.js        Layer 2    pluggable clustering (mutual k-NN, HDBSCAN, CC)
                                          → ClusterResult contract (multi-level)
        ↓
citations/registry.js         Layer 3    pluggable citation generation (taste-network)
                                          → CitationResult contract
                                          (bypassed under real-data mode)
        ↓
citation-layout/registry.js   Layer 4    citation-driven 3D arrangement (FR or MDS)
        ↓
blend/align.js                Layer 5a   per-component similarity alignment of the citation
                                          layout to basePos → alignedCitationLayout
blend/blend.js                Layer 5b   per-frame lerp:
                                          live = (1−α)·basePos + α·alignedCitationLayout
```

Math reference for each layer is in `doc/`. Start with
`doc/dynamics.md` for the index.

Doc highlights:
- `doc/clustering.md` — Layer 2 contract + algorithms
- `doc/citations.md` — Layer 3 contract + taste-network's four stages
- `doc/citation-layout.md` — Layer 4 algorithms (FR, MDS / SMACOF)
- `doc/blend.md` — Layer 5 (alignment math, blend formula, correlation metric)
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
    clustering-registry.js        Layer 2 dispatcher
    clustering.js                 L2: mutual k-NN
    clustering-hdbscan.js         L2: HDBSCAN
    clustering-cc.js              L2: connected components
    citations/                    Layer 3
      registry.js
      contract.js
      taste-network.js
    neighbourhoods.js             taste-network's stage 1
    citation-taste.js             taste-network's stages 2 + 3
    citations.js                  taste-network's stage 4
    base-edges.js                 visual base-edge selection
    citation-layout/              Layer 4
      registry.js
      contract.js
      fr.js                       L4: Fruchterman–Reingold
      mds.js                      L4: MDS / SMACOF
    blend/                        Layer 5
      align.js                    L5a: per-component similarity alignment
      blend.js                    L5b: per-frame lerp
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
        dimred-modal.js           four-stage
        data-source-modal.js
        panel-picker.js
        layer-descriptors.js
    main.js                       legacy boot + UI glue (drives legacy.html)
literture-network/                real-data pipeline (Python)
  artifacts/
    expanded_embeddings.npy       full SPECTER2 (810 k × 768)
    dev_subset/                   1000-paper carved subset
      expanded_embeddings.npy     subset embedding (n × 768, float32)
      expanded_embeddings_paper_index.json   row → paper_id
      subset_meta.json            provenance (seed, indices_into_source, …)
      citation_edges.json         induced citation-edge subgraph (carved separately)
  citgraphv2/output/
    edges.csv                     raw directed citation network
    nodes.csv                     paper metadata
  scripts/
    make_dev_subset.py            carve embedding subset
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
  deterministic blend between two precomputed arrangements,
  adds MDS as a second layout algorithm, adds the alignment-
  correlation metric and cross-algorithm layout sweep, plus all
  the slices documented in `doc/plan.md` (multi-level clustering,
  bridge analysis, data-source + dim-reduction layers, two
  viewers, save/load, optimisation + validation).
