# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running

No build, no bundler, no test framework, no linter. The app is a static page using ES modules — it must be served over HTTP (not opened as `file://`).

```bash
# from the repo root
python -m http.server 8000
# open http://localhost:8000/app/
```

Dependencies (`three`, `3d-force-graph`) load from unpkg via an import map in `app/index.html`. There is nothing to install.

The conda env (`enviroment.yml`, name `network-toy`) only carries `nodejs` + `playwright` for ad-hoc tooling; the app itself doesn't need it.

Quick syntax check on a module without running the page:

```bash
node --check app/src/<file>.js
```

## Architecture

The simulation is a **strict four-layer pipeline of pure functions**, one module per stage. Each stage reads the previous stage's output, never mutates it, and takes its own seed. Math reference for every stage is `doc/dynamics.md`.

```
generation.js       Layer 1  Gaussian-mixture sampling → {origins, nodes:[{basePos,t,originId}]}
        ↓
clustering.js       Layer 2  mutual k-NN over basePos → nodeCluster (connected components)
        ↓
neighbourhoods.js   Layer 3a mutual k-NN within each cluster → nodeNeighbourhood
citation-taste.js   Layer 3b per-neighbourhood taste vector + triangle boost
citations.js        Layer 3c Bernoulli per-pair sampling, respecting t_i > t_j
        ↓
hybrid-force.js     Layer 4  live spring force — runs every physics tick
```

Key invariants:

- **`basePos` is frozen at generation** and is the semantic ground truth. Layer 2/3 read it; Layer 4 uses pairwise distances over it as spring rest lengths.
- **`originId` ≠ cluster ID.** `originId` is the generator's mixture-component label (kept only for debug viz of the generator itself). Cluster IDs come from Layer 2 inferring structure from `basePos`.
- **One spring per unordered pair.** When a citation exists between i and j, the rest length collapses toward `(1−α)·‖basePos_i − basePos_j‖` and stiffness rises with α — this is the single knob the demo is built around.

### Live-physics wiring (the part that's easy to break)

`hybrid-force.js` is a force factory that closes over **getter callbacks** (`getAlpha`, `getBaseDist`, `getHasCit`, `getTensionCache`). The force is registered with the graph **once**; everything dynamic — α slider, citation regen, regeneration — flows through by mutating what those getters return. **Do not re-register the force or rebind nodes when state changes downstream.** That's how the previous version of this project broke.

`main.js` owns `state._baseDist` (Float32Array of pairwise basePos distances, recomputed once per regeneration) and `state._tensionCache` (Float32Array the force writes per tick for debug overlays to read).

### Pipeline orchestration in main.js

Each stage has its own re-run lane so a downstream parameter change doesn't redo upstream work:

- `regenerate()` — Layer 1 + precompute baseDist + reset live positions, then `recluster()`.
- `recluster()` — Layer 2, then `rerunNeighbourhoods()`.
- `rerunNeighbourhoods()` → `rerunTaste()` → `rerunCitations()` — each runs only its layer downward.

The α slider, "Generate", and citation modal apply/cancel are the entry points. Modules don't read `state`; `main.js` calls them with explicit args and stores results back into `state.<layer>Result`.

### THREE / 3d-force-graph load order

`three` r161+ removed the UMD build, but `3d-force-graph`'s UMD bundle still reads `window.THREE`. `app/index.html` imports THREE as an ES module via importmap, attaches it to `window.THREE`, **then** dynamically injects the 3d-force-graph `<script>`. Don't replace this with two static `<script>` tags — module scripts are deferred, so the UMD would run first and crash. 3d-force-graph@1.80 requires THREE ≥ 0.179.

## Known broken area

`issues.md` tracks the Debug ▾ overlays. They were written when nodes were pinned to `basePos` via `fx/fy/fz` (Layer 1 only). After Layer 4 was added, nodes stopped being pinned, live positions persist across rebuilds via `state._liveById`, and per-link materials are cloned for per-link opacity. The overlays haven't been refit for that. Treat the four-layer pipeline as correct; treat the debug overlays as suspect until verified.

## Conventions

- Use relative paths for Read/Edit/Write/Bash (e.g. `app/src/main.js`, not absolute paths).
- Random number generation goes through `rng.js` (`mulberry32` + Box-Muller). Layers must take an `rng` function as input rather than reach for `Math.random()` — this is how reproducibility per-seed is preserved.
- Layer modules are pure: no DOM, no rendering, no mutation of inputs. All DOM/UI glue lives in `main.js` and the corresponding `*-debug.js` files.
