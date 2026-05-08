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

v3 architecture: **two precomputed topologies, blended deterministically per frame**. Each layer is a pure function with its own seed; downstream layers see only the previous layer's public contract. Math references: `doc/dynamics.md` (the index — short pointer per layer), `doc/clustering.md` (Layer 2), `doc/citations.md` (Layer 3), `doc/citation-layout.md` (Layer 4), `doc/blend.md` (Layer 5: per-component alignment + per-frame lerp).

```
generation.js                       Layer 1  Gaussian-mixture sampling → {origins, nodes:[{basePos,t,originId}]}
        ↓
clustering-registry.js              Layer 2  pluggable clustering (mutual k-NN, HDBSCAN) → ClusterResult contract
        ↓
citations/registry.js               Layer 3  citation-generation registry — taste-network is the only entry today;
  taste-network.js                            internally runs neighbourhoods → taste → per-pair sampling.
                                              Public contract: { hasCit, inDeg, edges, citations, pools }.
        ↓
citation-layout/registry.js         Layer 4  citation-driven 3D arrangement. Two algorithms today:
  fr.js                                         FR (cladogram-flavoured, force-directed, time-axis radial anchor)
  mds.js                                        MDS (dendrogram-flavoured, SMACOF on graph-distance)
                                              Pure function of (n, edges, t, seed). Sees nothing from
                                              Layers 1–3 except the public CitationResult.
        ↓
blend/align.js                      Layer 5a per-component similarity alignment (rotation + match-RMS scale +
                                              translation) of citationPos to basePos → alignedCitationLayout.
                                              Returns alignmentCorrelation ∈ [0, 1] alongside.
blend/blend.js                      Layer 5b per-frame lerp: live = (1−α)·basePos + α·alignedCitationPos
```

Key invariants:

- **`basePos` is frozen at generation** and is the semantic ground truth for the α=0 endpoint of the blend. Layers 2/3 read it; Layer 4 deliberately does not.
- **`originId` ≠ cluster ID.** `originId` is the generator's mixture-component label (kept for debug viz of the generator only). Cluster IDs come from Layer 2 inferring structure from `basePos`.
- **The blend is linear in position.** The slider drives a deterministic function of α; round-tripping `0 → 1 → 0` returns the network to basePos byte-identical. There is no constraint solver, no momentum, no Kabsch each tick.
- **Layout module isolation.** `citation-layout/{fr,mds}.js` does not import basePos, clusters, or anything else from outside its own inputs. Per-component similarity alignment in `blend/align.js` is the only place where citationPos and basePos meet.

### Per-frame blend wiring (the part that's easy to break)

`blend/blend.js` is a factory that closes over **getter callbacks** (`getBasePos`, `getAlignedCitationPos`, `getBlend`). The hook is registered with the d3-force-3d graph **once** under the "blend" force slot; every dynamic change — slider drag, citation reroll, regeneration — flows through by mutating what those getters return. **Do not re-register the hook or rebind nodes when state changes downstream.** That's how the previous version of this project broke.

`main.js` owns:
- `state._basePos` — flat `Float32Array(n × 3)`, recomputed once per regeneration.
- `state.citationLayout` — raw output of the active citation-layout algorithm (FR or MDS), recomputed in `relayoutCitations()` whenever the citation graph or layout params change.
- `state.alignedCitationLayout` — `state.citationLayout` after per-component similarity alignment to basePos. This is what the blend hook actually consumes.
- `state.alignmentCorrelation` — `[0, 1]` quality metric returned by alignment alongside the buffer; surfaced as a live reading in the Citation Layout ▾ modal.
- `state.blend` — number in `[0, 1]`, written by the slider's `oninput`.

`d3VelocityDecay = 1.0` is required: it pins velocities at zero so the lib's `x += vx; vx *= 0` integration is a no-op alongside the blend hook's direct writes to `node.x/y/z`.

Slider drag still calls `Graph.d3ReheatSimulation()`. d3-force-3d's tick loop freezes when "the network looks settled" (instantly true under deterministic blending); without a reheat call, slider drags after the freeze go ignored.

### Pipeline orchestration in main.js

Each stage has its own re-run lane so a downstream parameter change doesn't redo upstream work:

- `regenerate()` — Layer 1 + `precomputeBasePos()` + reset live positions, then `recluster()`.
- `recluster()` — Layer 2, then `reneighbour()`.
- `reneighbour()` → `retaste()` → `resample()` — each runs only its sub-stage downward.
- `resample()` ends by calling `relayoutCitations()` so the new citation graph immediately produces a new `alignedCitationLayout` for the blend.
- `relayoutCitations()` — Layer 4 (active layout algorithm via the citation-layout registry) + Layer 5a (similarity alignment via `blend/align.js`, also computing `alignmentCorrelation`). Cached. Re-runs on citation change OR citation-layout-params change.

Modules don't read `state`; `main.js` calls them with explicit args and stores results back into `state.<layer>Result`.

### Registries

Three registries all follow the same shape:
- `clustering-registry.js` (Layer 2)
- `citations/registry.js` (Layer 3)
- `citation-layout/registry.js` (Layer 4)

Each entry exposes `{ id, label, description, defaultParams, infer | compute, modalSchema }`. The corresponding settings modal (Cluster ▾, Citations ▾, Citation Layout ▾) is rendered from the active algorithm's `modalSchema` — adding a new algorithm = one new entry, no UI markup edits.

### Eval surface

Two registries have parameter-sweep tooling exposed to the user:

- **Cluster** modal has a "Find best params" sweep that ranks (algorithm × params) combinations by ARI vs `originId` (ground truth from generation). Top results listed with per-row Apply. Lives in `app/src/eval/` (`ari.js`, `kmeans.js`, `sweep.js`).
- **Citation Layout** modal has the same UX, but ranks by `alignmentCorrelation` instead of ARI (no ground-truth labels for layouts). Crosses both algorithms (FR + MDS). `app/src/eval/layout-sweep.js`.

Both sweeps read each field's `sweepValues` array from the algorithm's `modalSchema` to build the cartesian grid — so adding a new algorithm with sensible `sweepValues` makes it sweepable for free.

### THREE / 3d-force-graph load order

`three` r161+ removed the UMD build, but `3d-force-graph`'s UMD bundle still reads `window.THREE`. `app/index.html` imports THREE as an ES module via importmap, attaches it to `window.THREE`, **then** dynamically injects the 3d-force-graph `<script>`. Don't replace this with two static `<script>` tags — module scripts are deferred, so the UMD would run first and crash. 3d-force-graph@1.80 requires THREE ≥ 0.179.

## Conventions

- Use relative paths for Read/Edit/Write/Bash (e.g. `app/src/main.js`, not absolute paths).
- Random number generation goes through `rng.js` (`mulberry32` + Box-Muller). Layers must take an `rng` function (or seed) as input rather than reach for `Math.random()` — this is how reproducibility per-seed is preserved.
- Layer modules are pure: no DOM, no rendering, no mutation of inputs. All DOM/UI glue lives in `main.js` and the corresponding `*-debug.js` files.
- New algorithms slot into the relevant registry. Don't grow switch statements on algorithm id elsewhere.
