# Network Dynamics Demonstrator

An interactive 3D toy for exploring how citation structure and a hybrid
spring force deform a semantic embedding. Built as a teaching / demo aid for
network-science intuition: drag a single α slider and watch the layout
trade off between "geometry" and "citation graph" in real time.

## Running

The app is a static web page that uses ES modules, so it must be served
over HTTP (not opened as `file://`).

```bash
# from the project root
python -m http.server 8000
# open http://localhost:8000/app/
```

No build step. All dependencies (`three`, `3d-force-graph`) load from
unpkg via an import map.

## Architecture

The pipeline is a clean chain of pure functions, each its own module:

```
generation.js       Gaussian-mixture sampling → basePos, t, originId
        ↓
clustering.js       mutual k-NN over all nodes → cluster IDs
        ↓
neighbourhoods.js   mutual k-NN within each cluster → neighbourhood IDs
        ↓
citation-taste.js   Stage 2 + 3 of the layered taste model
        ↓
citations.js        Stage 4 — Bernoulli per-pair sampling
        ↓
hybrid-force.js     live spring force, runs every physics tick
```

Each step has its own seed where it makes sense, and its own re-run lane,
so the user can roll any layer independently. The math is documented in
`doc/dynamics.md`.

## UI layout

```
┌─ topbar ──────────────────────────────────────────────┐
│ File ▾   Citations ▾   Debug ▾   Settings…           │
│ Generate   ❄ Freeze   seed: [42]                     │
├─ left ─────────────────┬─ canvas ─────────┬─ right ──┤
│ Clusters   k-NN slider │  3D graph        │ Cluster  │
│ Force      α slider    │  (live physics)  │ legend   │
│ Citations  density,    │                  │          │
│            intra,      │                  │          │
│            cross,      │                  │          │
│            seed        │                  │          │
├────────────────────────┴──────────────────┴──────────┤
│ Base edges  |  Citation edges  |  Nodes              │
└──────────────────────────────────────────────────────┘
```

- **Citations ▾ → Settings…** opens the citation-model modal (Stage 1
  k-NN, Stages 2 + 3 taste knobs, Stage 4 ε's, two seeds).
- **Settings…** opens the generation modal (nodes / origins / spread).
- **Debug ▾** has overlay toggles, grouped by layer.

## Layout

```
app/                static page + ES modules
  index.html
  src/
    rng.js                  shared seeded PRNG
    generation.js           Layer 1
    generation-debug.js     L1 overlays
    clustering.js           Layer 2
    clustering-debug.js     L2 overlays
    neighbourhoods.js       Stage 1 of L3
    citation-taste.js       Stages 2 + 3 of L3
    citations.js            Stage 4 of L3
    citations-debug.js      L3 link injection + in-degree colouring
    base-edges.js           visual base-edge selection
    hybrid-force.js         Layer 4 force factory
    physics-debug.js        L4 tension overlays
    main.js                 boot + UI glue
doc/
  dynamics.md         Math reference for all four layers
```
