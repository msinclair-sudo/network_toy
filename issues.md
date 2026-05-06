# Outstanding issues — debug overlay rebuild

Status as of commit `414d642` (initial commit of layered rebuild).

The four-layer pipeline (generation → clustering → neighbourhoods + taste +
sampling → hybrid spring force) is working correctly. The user-facing
levers (α, citation density / intra / cross, k-NN sliders, the citation
modal, base/citation edge controls) all behave as the math reference
(`doc/dynamics.md`) describes. Citations propagate through the live force
without rebinding; α reheats the simulation correctly and changes are
visibly reflected in the layout.

What does **not** work: the debug overlays under **Debug ▾**. They were
written for the static (Layer 1) viewer when every node was pinned to
`basePos` via `fx/fy/fz`. After Layer 4 was added, data nodes stopped
being pinned, live positions started persisting across rebuilds via
`state._liveById`, and per-link materials started being cloned to support
per-link opacity. None of the debug overlays were refit for that new
reality.

This document lists every debug toggle, the most likely failure mode for
each, the order to attack them in, and the open question for the user
about which symptoms are actually showing up so we don't waste time
chasing the wrong fix.

---

## Inventory: every Debug ▾ toggle

The Debug menu currently exposes seven checkboxes, grouped by layer:

### Generation

1. **show origin markers** — `dbg-origins`
   Toggles `debugFlags.showOrigins` in `generation-debug.js`. When on,
   `buildDebugGraph` injects N extra graph nodes (one per origin) with
   `id = "origin:N"`, `kind = "origin"`, and `fx/fy/fz` pinned to the
   origin's centre. `nodeThreeObject` swaps the default sphere for the
   crosshair-in-octahedron gizmo.

2. **origin → node edges** — `dbg-origin-edges`
   Requires (1). Adds one link per data node from `node.id` (integer) to
   `"origin:N"` (string), with `kind = "origin-edge"`. Coloured by origin
   in `colourForLink` of `generation-debug.js`.

3. **bounding cube** — `dbg-volume`
   Toggles `debugFlags.showVolume`. Adds/removes a wireframe `THREE.Group`
   directly to/from `Graph.scene()` via `ensureVolumeOutline()`. Doesn't
   touch graph data — purely a scene overlay.

### Clustering

1. **cluster centroids** — `dbg-centroids`
   Toggles `clusterDebugFlags.showCentroids`. Adds graph nodes with
   `id = "centroid:N"`, `kind = "centroid"`, `fx/fy/fz` pinned to the
   cluster centroid. `nodeThreeObject` swaps in a wire-tetrahedron gizmo.

2. **mutual k-NN edges** — `dbg-mutual-edges`
   Toggles `clusterDebugFlags.showMutualEdges`. Adds links between
   integer-ID data nodes for every mutual k-NN pair found by the
   clustering layer. Coloured `#5dd39e` in `colourForLink`.

### Physics

1. **citation tension** — `dbg-tension-cit`
   Toggles `physicsDebugFlags.tensionCitations`. When on, the link colour
   callback for citation edges defers to `colourForTension(t)` where `t`
   is the live spring tension `(d − ℓ) / d` written by the force into
   `state._tensionCache` every tick. Stretched → red, neutral → grey,
   compressed → blue.

2. **base tension** — `dbg-tension-base`
   Same idea as (6) but for base edges (the visual ones drawn when "show
   base" is on in the bottom bar).

---

## Hypotheses, in order of likely-to-fail

### H1 — Pinned debug gizmos may be misbehaving with physics on

**Suspects: 1, 4 (origin markers, cluster centroids).**

These gizmos are added as graph nodes with `fx/fy/fz` set, which tells
3d-force-graph to pin them. That part is unchanged from when it worked
in Layer 1.

What *did* change: `buildDebugGraph` now reads from `state._liveById` to
preserve live positions of *real data nodes* across rebuilds. The block
that handles origin / centroid markers still sets `fx/fy/fz` from the
origin or centroid object, so pinning should still work.

**Likely failure mode**: there's no failure for the gizmos themselves.
But the user reports "all of the features in debug aren't working as
expected" — so something in this path is wrong.

**Diagnostic plan**: open Debug ▾, tick "show origin markers" *with no
physics happening* (α=0 + 0 citations). The 100 nodes sit at basePos and
the 6 origin gizmos should appear at their centres. If they don't, the
problem is structural, not physics-related.

If the gizmos *do* appear at α=0 / 0 citations but disappear or drift at
α=2 + lots of citations, the problem is that `liveById` is silently
copying zero-velocity into the *gizmo* node objects. This shouldn't
happen — `liveById` is only populated for `kind === "node"`, not
`"origin"` or `"centroid"`. Worth verifying anyway.

---

### H2 — Tension overlays do nothing because materials are cloned

**Suspects: 6, 7 (citation tension, base tension).**

This is the most likely real bug, and it's a consequence of how
3d-force-graph handles per-link rendering.

The library caches `LineBasicMaterial` instances by colour string — every
link that resolves to the same hex string gets the same material
reference. The per-link opacity hook in `installPerLinkOpacityHook`
solved that for opacity by replacing each link's material with a clone:

```js
if (!obj.material.__perLink) {
  obj.material = obj.material.clone();
  obj.material.__perLink = true;
  obj.material.transparent = true;
}
obj.material.opacity = opacityForLink(l);
```

But the **colour** of those cloned materials is set *once*, when the
clone is created, from whatever colour `Graph.linkColor(colourForLink)`
resolved to at that moment. After cloning, calling `Graph.linkColor(...)`
again does not propagate new colours to the clones — they're independent
material objects.

When the user ticks "citation tension" on:

- We call `Graph.linkColor(colourForLink)` so the lib re-resolves colour.
- But the existing cloned materials still hold their old colour.
- New materials created from this point would pick up the new colour,
  but no new materials get created until graph data rebuilds.
- Result: the user sees the original citation colour, not the
  tension-mapped colour.

**Fix sketch**: extend the existing per-link tick loop in
`installPerLinkOpacityHook` to also update `material.color`. Read from
`colourForLink(l)` every frame, not just at clone time. This is cheap —
the THREE colour parser handles a hex string in microseconds, and we're
already iterating per link per frame for opacity.

```js
// inside the existing rAF tick, after opacity:
const colourString = colourForLink(l);
if (obj.material.__lastColour !== colourString) {
  obj.material.color.set(colourString);
  obj.material.__lastColour = colourString;
}
```

The `__lastColour` cache prevents an unnecessary `.set()` every frame
when nothing changed, which avoids the per-link string-to-colour parse.

---

### H3 — Bounding cube might never get re-added after debug rebuilds

**Suspect: 3 (bounding cube).**

`ensureVolumeOutline()` is called from inside `loadGraphData()` and
manages a `THREE.Group` added directly to `Graph.scene()`. It removes
the old group and creates a fresh one if `debugFlags.showVolume` is on.

This is fine on the surface but: 3d-force-graph internally calls
`scene.clear()` on certain transitions (notably engine state transitions
during the warmup ticks). If the scene is cleared between when we add
our cube and when the user looks at it, the cube vanishes silently and
won't come back until the user toggles the checkbox.

**Diagnostic plan**: tick "bounding cube" on, observe whether it appears
at all. If it does, drag α to make the sim warm/cool — does the cube
disappear?

**Fix sketch (if confirmed)**: hook into `Graph.onEngineTick` or just
re-add the cube every few hundred ms via the existing per-link rAF tick
loop. Cheaper option: call `ensureVolumeOutline()` from a one-time
`onEngineTick` subscription so the lib's internal scene management
doesn't strand it.

---

### H4 — Mutual k-NN edges might just look ugly, not be broken

**Suspect: 5.**

This overlay adds graph links between integer-ID data nodes. With
physics on, both endpoints move. The link is drawn correctly by the
library — but the user might *expect* the mutual k-NN graph to remain at
the embedding (basePos) positions, since that's where the algorithm
actually ran.

If the user thinks of the mutual k-NN graph as "the static structure
that defined the clustering," then watching its edges deform under α is
visually misleading, even though it's technically correct.

**Possible interpretations**:

- (a) Expected: edges follow the live nodes. Then this overlay isn't
  broken; it just doesn't match the user's intuition.
- (b) Wanted: render the edges at basePos coordinates regardless of
  current node positions. That requires custom THREE line geometry, not
  graph-data links.

We'd need to ask the user which they want.

---

### H5 — In-degree colour mode might be reading stale data

**Not a Debug ▾ toggle, but related.**

The bottom-bar `colour by: citation in-degree` mode reads from
`state.citationResult.inDeg`. If the user changes citation rates → the
sampling reruns → `state.citationResult` is replaced → the next
`Graph.nodeColor(colourForNode)` call reads from the new array. This
should work.

The risk: between rebuilds, the old graph data still has its old
materials. Same problem as H2. If colour-by-indegree "doesn't update
when citations change", the per-link tick loop fix from H2 will fix it
(or rather, the equivalent fix on the per-node side).

But nodes don't have the material-clone hook applied — they use the
default 3d-force-graph node shaders, which *do* re-read `nodeColor` on
refresh. So in-degree colouring probably works fine. Verify.

---

## Order of attack

Each step in its own commit so we have a clean history.

### Step 1 — Audit `buildDebugGraph` and the structural debug toggles

Goal: confirm that origin gizmos, centroid gizmos, origin → node edges,
and mutual k-NN edges still render at all in the new physics-enabled
viewer. Boot the page, tick each toggle, screenshot.

If any of them silently fails to appear:

- Check that `nodeThreeObject` is still being applied (likely yes).
- Check that the gizmo's `fx/fy/fz` is being respected (look at
  `Graph.graphData().nodes` after the toggle).
- Check that `loadGraphData` is being called when the toggle changes
  (it is — but the lib might not pick up new nodes if the rebuild
  doesn't trigger an internal `rebuildScene()`).

Probably small fixes. Estimate: 30–60 min.

### Step 2 — Fix the per-link tension overlay (H2)

Goal: extend `installPerLinkOpacityHook` so it also writes the live
material `.color` from `colourForLink(l)` every frame, with a
`__lastColour` cache to avoid redundant work.

Test: tick "citation tension" with α=2 and lots of citations. Should
see blue (compressed) cited springs all over the place.

This is the highest-leverage fix because it unblocks both physics
debug overlays plus any other "live colour mode" we want to add later.

Estimate: 15 min.

### Step 3 — Verify / fix the bounding cube (H3)

Goal: confirm the cube survives across α changes and citation rebuilds.
If it doesn't, hook `ensureVolumeOutline` to `onEngineTick` so it's
re-added if the scene clears.

Estimate: 15 min unless the lib's scene management is more aggressive
than I think.

### Step 4 — Decide on mutual k-NN edge semantics (H4)

Ask the user: "do you want mutual k-NN edges to follow the live physics,
or stay at basePos (static)?"

If "follow live": no work needed. If "stay at basePos": small custom
THREE geometry, ~30 min.

### Step 5 — Visual sanity pass

Open Debug ▾, tick each toggle individually, screenshot, eyeball.
Confirm everything works at α=0, α=1, α=3. Confirm interaction with
edge gamma sliders, colour-by mode, freeze toggle. File any new bugs as
follow-ups.

Estimate: 20 min, mostly just clicking around.

### Step 6 (optional) — Polish

Things to consider once the structural fixes are in:

- Origin gizmo size relative to spreadScale (they're currently fixed at
  ~4 scene units, which is fine for spreadScale=1 but tiny when
  spreadScale=4).
- Centroid gizmo distinguishability against the cluster's own colour
  (currently uses the cluster colour for the marker — which means the
  marker can blend in).
- Tension overlay only running when *something* is in tension. At α=0
  every tension is zero so all citation edges go grey. That's correct,
  but might surprise the user — could add a status hint.

---

## Open questions for the user

These will save thrashing. **Please answer before I start step 1.**

1. **Which toggles are visibly broken?** Specifically, when you open
   Debug ▾ and tick each box, what *does* and *doesn't* happen?
   - "show origin markers": ?
   - "origin → node edges": ?
   - "bounding cube": ?
   - "cluster centroids": ?
   - "mutual k-NN edges": ?
   - "citation tension": ?
   - "base tension": ?

2. **For "mutual k-NN edges"** — should they follow the live physics
   (deform when α is high), or stay anchored at basePos (always show
   the static clustering structure)?

3. **For tension overlays** — when both "citation tension" and "base
   tension" are on at the same time, do you want them to share the same
   colour scale (red/blue), or use *different* tension colour scales so
   you can tell at a glance which kind of edge you're looking at? My
   default would be: same scale, different *line widths* (citation
   wider than base, as today). But happy to do otherwise.

4. **Bounding cube** — happy with the current blue wireframe colour and
   opacity (35%), or want to tune?

---

## Once these are fixed

The whole network-toy app will be in working state across all surfaces.
At that point a follow-up wishlist (not bugs, just nice-to-haves):

- Persist app state to JSON (the v1 File ▾ menu had this; currently
  stubbed out in our shell).
- "Cluster taste" debug visualisation: arrows between cluster centroids
  showing which clusters are in T(c) for each c. This would make the
  staged citation model legible at a glance.
- Neighbourhood overlay: draw a soft hull or sub-coloured halo per
  neighbourhood. Would make sparse-cluster-many-Ng cases obvious.
- Single-click a node → highlight its citations + its neighbourhood.
  Tooltips already show some of this; click-to-pin would help during
  presentations.
- Live performance work: the inner-loop force is O(n²) per tick. Fine
  at n=100; would chug at n=1000+. Not a problem until it is.
