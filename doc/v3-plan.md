# v3 architecture plan: two-topology blend

This is the plan we settled on before any code changes started. Branch
`v3` begins from `v2 stage 6` (`7a52260`). All v3 work commits on top
of that as `v3 stage N: …` so any phase can be reverted independently.

## Goal

Replace the constraint-solver-with-α-as-stiffness model with a
**deterministic blend between two precomputed topologies**:

- **basePos** (`α = 0`) — the Gaussian-mixture cloud from the
  generation seed. Already exists as `node.basePos`.
- **alignedCitationPos** (`α = 1`) — a deterministic 3D layout
  derived **only** from the citation graph topology, then rigidly
  aligned to basePos per connected component.

Per-frame work:

```
live_i  =  (1 − α) · basePos_i  +  α · alignedCitationPos_i
```

That's it. No constraint solver, no momentum, no Kabsch each tick (a
one-shot per-component Kabsch happens during alignment, cached).
Per-frame cost is `n` lerps.

## Core mental model

The slider expresses **which topology drives layout**. At `α = 0`
the basePos cloud is what you see; at `α = 1` the citation graph
drives every node's location and the basePos arrangement has zero
effect; in between is a smooth blend.

This frames the toy as a **topology comparison demo**, not a physics
demo. The two endpoints are static and deterministic; only the slider
animates.

## Module separation

The encapsulation boundary that matters: **the citation-layout module
must not see how citations were generated**, only the resulting edge
graph. Likewise it must not see basePos — that would bias the
"pure citation topology" arrangement. Alignment to basePos is a
separate concern, owned by the blend module.

```
Layer 1   generation.js               → basePos          [unchanged from v2]
Layer 2   clustering.js               → clusters         [unchanged from v2]
Layer 3   citation-gen registry       → citation graph   [REFACTORED in v3]
Layer 4   citation-layout registry    → citationPos      [NEW]
Layer 5   blend (align + lerp)        → live position    [NEW; replaces hybrid-force.js]
```

Each registry is a single source of algorithm choice + params, mirroring
the existing clustering-registry. New algorithms slot in by adding an
entry — no other code edits needed.

## Layer-by-layer detail

### Layer 3 — citation-generation registry

Existing implementation (`citations.js` + `citation-taste.js` +
`neighbourhoods.js`) keeps working byte-for-byte; it gets wrapped in a
single registry entry (`taste-network` or similar). The registry
exposes only a clean public contract:

```
infer(genResult, clusterResult, params)
  → { hasCit: Uint8Array(n²), inDeg: Int32Array(n), edges: [[i,j], …] }
```

Other algorithms can be added later (random Erdős–Rényi, time-ordered
DAG, etc.) by registering more entries. Phase 1 only does the wrapping;
no behaviour change.

### Layer 4 — citation-layout registry

New module producing 3D positions from the citation graph alone. Same
shape as the clustering registry. Phase 2 ships one algorithm:

#### `citation-layout/fr.js` — Fruchterman–Reingold in 3D

- **Pure function**: input is the citation graph + node count + a layout
  seed; output is `Float32Array(n × 3)`. Does not see basePos, clusters,
  or any generation metadata.
- **Initial positions**: random in unit sphere, seeded from the
  citation seed (no separate slider).
- **Iteration loop**: 200 iterations (default; exposed in modal so the
  user can trade speed for quality).
- **Per-iteration force budget**:
  - **Repulsion** between every node pair: `f_rep(d) = -k² / d`
  - **Attraction** along citation edges only: `f_att(d) = d² / k`
  - **Time-axis bias (radial anchor)** per node: weak pull toward
    origin proportional to `(1 − t_i)`. Older nodes (low `t`) end
    up nearer the centre; younger nodes drift outward under
    repulsion. The cladogram is **unrooted** (no axis is privileged)
    — `t` only sets radial preference. Anchor strength is a `tBias`
    modal param (default ~0.5 of repulsion strength; will be tuned
    empirically).
- **Cooling schedule**: linear temperature decay over the iterations.
- **Disconnected components**: handled by the radial anchor — every
  node feels at least the gentle pull inward, so isolated nodes form
  a sparse shell rather than drifting to infinity. Per-component
  alignment in Layer 5 then places them sensibly relative to basePos.

### Layer 5 — blend (align + lerp)

Two sub-modules.

#### `blend/align.js`

Takes basePos and the raw FR-output citationPos, returns
`alignedCitationPos`.

- **Connected components** of the citation graph computed via union-find.
  Degree-0 nodes are singleton components.
- **Per-component Kabsch alignment**: each component independently
  computes the optimal rigid transform (rotation + translation) that
  maps its citationPos subset → its basePos subset, applied in place.
- For a singleton (isolated node), this is just translation: the
  node lands at its basePos.
- For larger components, internal FR geometry is preserved (Kabsch
  is rigid; doesn't deform), only orientation and centroid are
  aligned.
- Result: each citation component sits roughly where its basePos
  analogue sits, but with citation-driven internal structure intact.

This is the resolution to the "isolated regions" problem. The layout
module remains pure (it never sees basePos); alignment is a separate
post-process owned by the blend module, whose entire job is mediating
between the two arrangements.

**Cost**: `O(N + E)` for union-find; each component's Kabsch is
`O(component_size)` (3×3 cross-correlation + 4×4 eigendecomp). Sum
is `O(N + E)`. Runs once when citations change, cached.

**Known cosmetic risk**: per-component alignment can let two different
components overlap if their basePos centroids coincide. Geometrically
correct (no edges between them = no spacing constraint), visually
possibly confusing. Defer until we see real layouts.

#### `blend/blend.js`

Per-frame application:

```
for each data node i:
  live.x = (1 − α) · basePos[i*3]   + α · alignedCitationPos[i*3]
  live.y = (1 − α) · basePos[i*3+1] + α · alignedCitationPos[i*3+1]
  live.z = (1 − α) · basePos[i*3+2] + α · alignedCitationPos[i*3+2]
```

Lives where the PBD solver currently does — registered as a d3-force-3d
"force" hook so it runs each tick, but mutates positions directly
(d3VelocityDecay stays at 1.0 so `vx += 0; x += vx` is a no-op). No
state, no iteration count, no parameters.

## Slider

- Renamed from **α** to **blend** in the UI; state field `state.alpha`
  → `state.blend`.
- Range strictly **[0, 1]**, step 0.005.
- **0** = pure basePos, **1** = pure alignedCitationPos. No
  extrapolation past 1.

## What survives v2 verbatim

- `generation.js` (Layer 1)
- `clustering.js` + clustering-registry (Layer 2)
- HDBSCAN module + cluster eval modal column from v2 stage 5
- `citations.js` + `citation-taste.js` + `neighbourhoods.js` internally
  (just wrapped behind registry in Phase 1)
- Displacement debug overlay (still useful — even with deterministic
  blend, showing per-node basePos→aligned vectors is informative)

## What goes away

- `hybrid-force.js` and the entire PBD solver
- All physics constants (`PBD_ITERATIONS`, `PBD_STIFFNESS`, `ALPHA_MAX`)
- The Kabsch alignment pass that ran every PBD tick (replaced by
  one-shot per-component Kabsch in `blend/align.js`)
- `state._baseDist` (PBD needed pairwise distances; blend doesn't)
- `d3ReheatSimulation()` calls on slider drag (no simulation to reheat)

## Phase plan

Each phase is one commit on the `v3` branch with a `v3 stage N: …`
title, so individual phases can be reverted.

### Phase 1 — Citation generation registry (refactor only)

**Acceptance**: at a fixed seed, the new code path produces a
`hasCit` array byte-for-byte identical to the pre-refactor output.

- New: `app/src/citations/registry.js`, `app/src/citations/contract.js`
- New: `app/src/citations/taste-network.js` (wraps existing
  citations.js / citation-taste.js / neighbourhoods.js behind the
  registry's `infer` interface)
- Modified: `main.js` calls go through the registry

### Phase 2 — Citation layout module (FR algorithm, no UI yet)

**Acceptance**: at a fixed citation seed + graph, FR produces a
deterministic positions array. Visual check that connected
components look citation-like and isolated nodes form a sparse
peripheral shell.

- New: `app/src/citation-layout/registry.js`,
  `app/src/citation-layout/fr.js`,
  `app/src/citation-layout/contract.js`
- Modified: `main.js` adds `state.citationLayout` (Float32Array) and
  a `relayoutCitations()` lane that runs on citation reroll.
- Not yet wired to rendering — Phase 3 does that.

### Phase 3 — Blend layer + alignment (replaces PBD)

**Acceptance**: slider behaves like a deterministic blend, network
returns to exact basePos at α=0 and exact alignedCitationPos at α=1.

- New: `app/src/blend/align.js`, `app/src/blend/blend.js`
- Deleted: `app/src/hybrid-force.js`
- Modified: `main.js` — drop PBD registration, register blend hook.
  Drop `state._baseDist` (no longer needed). Add
  `state.alignedCitationLayout` (Float32Array) computed when
  citations change.

### Phase 4 — UI / wiring

**Acceptance**: slider labelled `blend`, range 0..1, value display
shows two decimals. Citation Layout ▾ menu in topbar mirroring
Cluster ▾, opens settings modal driven by layout registry's
`modalSchema`.

- Modified: `index.html` — slider `min=0 max=1 step=0.005`, label
  rename, new Citation Layout ▾ topbar entry, modal markup.
- Modified: `main.js` — slider handler writes `state.blend` (renamed),
  remove reheat call (no sim to reheat). Add layout-modal binding
  that mirrors the cluster-modal pattern from stage 0b/5.

### Phase 5 — Docs + cleanup

- Rewrite `doc/dynamics.md` §4 for the blend model; keep §1–§3.
- New: `doc/citation-layout.md` with the FR + alignment math.
- Update `CLAUDE.md` architecture diagram and live-physics section.
- Wipe `issues.md` of v2-era physics notes.
- Delete physics-targeted scripts in `scratch/` (the diagnostic
  harnesses for PBD / runaway / rotation tracking).

## Future work (explicitly NOT v3 scope)

- **Stress-tracking overlay**: visualise per-edge distortion at the
  current blend value. Useful for finding "natural" α values where
  one topology dominates without conflict.
- **Optimal transition state**: instead of pure linear lerp,
  precompute or compute-on-demand a midpoint arrangement that
  minimises max-stress along the path. Piecewise-linear blend
  through it.
- **Inter-component spacing pass** in `blend/align.js`: after
  per-component Kabsch, push overlapping components apart along the
  vector between their centroids. Defer until we see whether
  overlap is actually a UX problem.
- **More citation-layout algorithms**: spectral, hierarchical
  tree-by-`t`, MDS on graph distances. Easy adds via the registry.
- **More citation-generation algorithms**: random Erdős–Rényi,
  preferential attachment, time-ordered DAG. Easy adds via the
  registry.

## Decisions log (settled)

| Question                                           | Resolution                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Citation layout algorithm                          | Force-directed (FR) on citation edges only                                  |
| Slider range                                       | Strict `[0, 1]`, no extrapolation                                           |
| Layout seed                                        | Derived from citation seed (no separate UI knob)                            |
| FR iteration count                                 | 200 default, exposed in modal                                               |
| Time-axis (`t`) treatment                          | Per-node radial anchor, strength `(1 − t_i) · tBias`. Unrooted              |
| Isolated regions                                   | Per-component Kabsch alignment in the blend module (not the layout module)  |
| Slider name                                        | `blend`                                                                     |
| Encapsulation                                      | Layout module never sees basePos. Alignment owned by blend module           |
| Citation generation refactor                       | In v3 (Phase 1), as a registry shell around existing implementation         |
| Base edges                                         | Render-only, density slider already filters by edge length percentile       |
| Phasing                                            | Five separately-revertible commits; Phase 1 is mechanical, no behaviour drift |

## Decisions deferred

- Inter-component spacing logic in alignment (wait and see)
- Stress-tracking metric / overlay (future enhancement)
- Whether to also add a layout modal for FR knobs in Phase 2 or
  defer to Phase 4 (probably Phase 4 — keep Phase 2 self-contained
  and visualisable via diagnostic scripts only)
