# Network Dynamics Demonstrator

An interactive 3D toy for comparing **two arrangements of the same
network**: the spatial embedding nodes are generated from, vs. a
layout derived purely from the citation topology between them. A
single slider blends between them — α=0 is the embedding, α=1 is
the citation-driven arrangement, anything in between is a smooth
deterministic interpolation.

Built as a teaching / demo aid for network-science intuition. Lets
you ask "what does this dataset look like as positions vs. as a
graph?" and watch the answer fade between the two.

## Running

The app is a static web page that uses ES modules, so it must be
served over HTTP (not opened as `file://`).

```bash
# from the project root
python -m http.server 8000
# open http://localhost:8000/app/
```

No build step. All dependencies (`three`, `3d-force-graph`) load from
unpkg via an import map.

## What you do with it

The current shell is at `http://localhost:8000/app/`. The original
v3 demo shell is preserved at `http://localhost:8000/app/legacy.html`.

### Workflow chart (left rail)

A small SVG of the pipeline. Click any method node — **Clustering**,
**Cit. layout** — to open its modal. Each modal swaps the active
algorithm and tunes its parameters, then re-runs the right engine
lane on Apply.

### Multi-level clustering

The Clustering modal supports a **stack of clustering levels**.
Each level has its own params; non-root levels also have a scope
toggle:

- **global** — re-cluster the whole dataset at this level's params
  (often a finer resolution).
- **within parent** — run the algorithm within each previous-level
  cluster's members only.

Mix freely. Add levels with **+ Add level**, remove with **×**.
Same algorithm shared across all levels (per the design call:
better story).

### Bridge analysis (Layer 2.5)

When ≥ 2 clustering levels exist, the toy automatically computes
which fine clusters span multiple coarse clusters — the **bridge
clusters**. These are surfaced as new colour modes in the 3D
viewer (`bridge`, `boundaryScore`) and as new sources in the node
table (`bridge`, `boundaryScore`).

### 3D viewer (primary panel)

Live blend visualisation. Top-left: **Colour by:** dropdown
selects what drives node colour (cluster level, origin, time,
in-degree, bridge, boundary score). Top-right: **⚙** opens
camera-speed settings.

### Node table (secondary panel — the legend)

A mode-aware table that doubles as the legend for whatever's
colouring the viewer. Source dropdown at top: **Auto** follows
the viewer's colour mode, or pin to a specific source. Continuous
gradients (in-degree / time / boundary score) display a
min↔max gradient bar at the top of the table.

### Blend slider (left rail bottom)

Sweeps `α: 0 → 1`. At α=0 you see the embedding; at α=1 you see
the citation-driven layout (per-component aligned so the two
views share scale/orientation); in between is a per-frame linear
interpolation. Round-trip is exact.

### Topbar menus

**Data** (load/generate), **Workflow** (preset save/load),
**Validate** (bootstrap stability, ARI sweeps — pending),
**Help** (about).

### Multi-tab panels

Every slot — primary, secondary, bottom — has tabs. Click `+` to
add a new panel via a picker modal listing all registered panel
types. `×` on a tab closes it. The 3D viewer is a singleton (one
WebGL context only); other types can have multiple instances.

## Architecture

Five-layer pipeline of pure functions. Each layer takes the previous
layer's public contract and produces its own — adding a new clustering /
citation-generation / citation-layout algorithm is one new entry in
the relevant registry, no other file changes needed.

```
generation.js                 Layer 1   Gaussian-mixture sampling → basePos, t, originId
        ↓
clustering-registry.js        Layer 2   pluggable clustering (mutual k-NN, HDBSCAN)
                                          → ClusterResult contract
        ↓
citations/registry.js         Layer 3   pluggable citation generation (taste-network today)
                                          → CitationResult contract (hasCit, edges, inDeg, …)
        ↓
citation-layout/registry.js   Layer 4   citation-driven 3D arrangement (FR or MDS)
                                          pure function of the citation graph
        ↓
blend/align.js                Layer 5a  per-component similarity alignment of the citation
                                          layout to basePos → alignedCitationLayout
                                          (also returns a [0, 1] correlation coefficient)
blend/blend.js                Layer 5b  per-frame lerp:
                                          live = (1−α)·basePos + α·alignedCitationLayout
```

Math reference for each layer is in `doc/`. Start with
`doc/dynamics.md` for the index; each layer has its own dedicated
doc:

- `doc/clustering.md` — Layer 2 contract + algorithms (mutual k-NN, HDBSCAN, connected-components)
- `doc/citations.md` — Layer 3 contract + the taste-network algorithm's four stages
- `doc/citation-layout.md` — Layer 4 algorithms (FR force formulae, MDS / SMACOF)
- `doc/blend.md` — Layer 5 (alignment math, blend formula, correlation metric, why deterministic blend rather than a constraint solver)
- `doc/multi-level.md` — multi-level clustering (state.clusterLevels, scope flag, within-parent stitching) + bridge analysis derivation (Layer 2.5)
- `doc/ui-architecture.md` — the new shell at `app/src/ui/` (state container, engine orchestrator, workflow chart, panel system, modals, gradients, selection types, patterns for adding panels / colour modes / layers)
- `doc/scaling.md` — toy-vs-real-data scaling analysis: which layers' big-O carries to `n = 810 k` base / 1.82 M filtered hybrid edges, where the cliffs are, and the trade-offs at each (Barnes–Hut FR, pivot/landmark MDS, sparse k-NN clustering, sparse `hasCit`)
- `doc/clustering-research.md` — research record: per-family pros/cons, locked picks, stability metrics catalogue
- `doc/plan.md` — convergence plan with status flags per item

## UI layout

```
┌─ topbar ──────────────────────────────────────────────────────┐
│ File ▾  Cluster ▾  Citations ▾  Citation Layout ▾  Debug ▾   │
│ Settings…  Generate  ❄ Freeze  seed: [42]                    │
├─ left panel ─────────────┬─ canvas ────────┬─ right ──────────┤
│ Blend     blend slider   │  3D graph       │  Cluster legend  │
│ Citations density        │                 │  (per-cluster    │
│           intra          │                 │   colour swatch  │
│           cross          │                 │   + count)       │
│           seed           │                 │                  │
├──────────────────────────┴─────────────────┴──────────────────┤
│ Base edges  |  Citation edges  |  Nodes (colour-by mode)      │
└───────────────────────────────────────────────────────────────┘
```

## File layout

```
app/                          static page + ES modules
  index.html
  src/
    rng.js                    shared seeded PRNG (mulberry32 + Box-Muller)
    generation.js             Layer 1
    generation-debug.js       L1 overlays
    clustering-registry.js    Layer 2 dispatcher
    clustering.js             L2: mutual k-NN
    clustering-hdbscan.js     L2: HDBSCAN
    clustering-debug.js       L2 overlays
    citations/
      registry.js             Layer 3 dispatcher
      contract.js             CitationResult validator
      taste-network.js        L3: taste-network algorithm wrapper
    neighbourhoods.js         taste-network's stage 1
    citation-taste.js         taste-network's stages 2 + 3
    citations.js              taste-network's stage 4 (Bernoulli sampling)
    citations-debug.js        L3 link injection + colour-by-in-degree
    base-edges.js             visual base-edge selection
    citation-layout/
      registry.js             Layer 4 dispatcher
      contract.js             layout-output validator
      fr.js                   L4: Fruchterman–Reingold
      mds.js                  L4: MDS / SMACOF
    blend/
      align.js                L5a: per-component similarity alignment
      blend.js                L5b: per-frame lerp
    eval/
      ari.js                  Adjusted Rand Index for cluster sweep
      kmeans.js               k-means baseline for cluster sweep
      sweep.js                generic param sweep (clustering)
      layout-sweep.js         cross-algorithm sweep (citation-layout)
    contracts/
      cluster.js              ClusterResult validator
    physics-debug.js          L5 displacement overlay
    main.js                   boot + UI glue
doc/
  dynamics.md                 index — short pointer per layer
  clustering.md               Layer 2
  citations.md                Layer 3
  citation-layout.md          Layer 4
  blend.md                    Layer 5
```

## Branches

- `main` — historical v1 (original spring force).
- `v2` — adds HDBSCAN clustering and the cluster-eval modal; still
  uses the spring / PBD layout solver. Final v2 commit is
  `v2 stage 6: PBD layout solver replacing spring physics`.
- `v3` — current. Replaces the constraint solver entirely with
  deterministic blend between two precomputed arrangements, adds
  MDS as a second layout algorithm, adds the alignment-correlation
  metric and cross-algorithm layout sweep.
