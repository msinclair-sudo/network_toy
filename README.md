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

- Hit **Generate** to draw a fresh node cloud (Gaussian-mixture
  sampling — change `seed`, `nodes`, `origins`, `spread` in the
  Settings… modal).
- **Cluster ▾** picks how clusters are inferred from the cloud
  (mutual k-NN or HDBSCAN). Each algorithm has its own settings
  modal with a "Find best params" sweep that scores combinations
  against the generator's ground-truth labels (Adjusted Rand
  Index).
- **Citations ▾ → Settings…** controls how the citation graph is
  generated from clusters + a per-neighbourhood "taste" model.
  Density / intra-cluster / cross-cluster sliders are also on the
  left panel for quick adjustment.
- **Citation Layout ▾** picks how the citation-driven arrangement is
  computed:
  - **Fruchterman–Reingold** (cladogram-flavoured): every pair
    repels, citation edges attract, plus a time-axis radial anchor
    that draws older nodes toward the centre.
  - **MDS** (dendrogram-flavoured): per-pair distance in 3D matches
    graph-shortest-path distance. A 1–2–3 chain ends up collinear
    with `|x_1 − x_3| = 2 · |x_1 − x_2|`.
  Both modals expose a "Find best params" sweep that crosses
  algorithms × parameters and ranks results by alignment
  correlation with the embedding (= "how well does this layout
  reproduce the embedding's structure?").
- **The blend slider** in the left panel sweeps `α: 0 → 1`. At α=0
  you see the embedding; at α=1 you see the citation-driven
  layout (per-component aligned to the embedding so the two views
  are at the same scale and orientation); in between is a
  per-frame linear interpolation. Round-trip is exact — sweeping
  back to α=0 returns every node to its original position.
- **Debug ▾** has overlay toggles grouped by layer (origin
  markers, cluster centroids, structure edges, noise rings,
  displacement lines).

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

- `doc/clustering.md` — Layer 2 contract + algorithms (mutual k-NN, HDBSCAN)
- `doc/citations.md` — Layer 3 contract + the taste-network algorithm's four stages
- `doc/citation-layout.md` — Layer 4 algorithms (FR force formulae, MDS / SMACOF)
- `doc/blend.md` — Layer 5 (alignment math, blend formula, correlation metric, why deterministic blend rather than a constraint solver)
- `doc/scaling.md` — toy-vs-real-data scaling analysis: which layers' big-O carries to `n = 800k` base / 1.9M citations, where the cliffs are, and the trade-offs at each (Barnes–Hut FR, pivot/landmark MDS, sparse k-NN clustering, sparse `hasCit`)

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
