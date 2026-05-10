# UI architecture

This document specifies the new shell at `app/src/ui/`. The legacy
shell (`app/legacy.html` + `app/src/main.js` + `app/src/*-debug.js`)
is preserved but no longer the primary entry point; everything new
goes through this architecture.

The UI architecture has four pillars:

1. **State container** — single `state` object, vanilla
   `getState / update / subscribe` plus typed actions.
2. **Engine orchestrator** — pure-function pipeline lanes that
   read inputs from `state`, run engine modules (unchanged from
   the legacy), write results back to `state`.
3. **Layered visual layout** — workflow chart (left rail) + panel
   system (three slots) + topbar / blend slider, all wired via
   subscribers.
4. **Registry-based extensibility** — every layer (clustering,
   layout, dim-reduction) and every panel type plugs in via a
   one-entry registration.

Reading order: the rest of the doc follows the data flow — state
first, engine second, UI surfaces third.

---

## 1. File layout

```
app/
  index.html                — new shell entry
  legacy.html               — archive of the v3-stage-X shell, fully working
  styles/main.css           — grid layout + all UI styling
  src/
    ui/
      main.js               — bootstrap; mounts each subsystem into its DOM slot
      state.js              — single state container + actions
      engine.js             — pipeline orchestrator (regenerate / recluster / …)
      bridge-analysis.js    — multi-scale boundary derivation (Layer 2.5)
      gradients.js          — shared colour-stop arrays + interp + linear-gradient CSS
      topbar.js             — Data / Workflow / Validate / Help menus
      data-panel.js         — top-left data info / toy params
      workflow-chart.js     — SVG DAG of the pipeline; click → modals
      panel-system.js       — manages primary / secondary / bottom slots; tabs + ± buttons
      panels/
        registry.js         — panel-type registry
        viewer-3d.js        — live blend visualisation; colour-mode dropdown + camera settings
        node-table.js       — mode-aware legend table (the right-side panel)
        placeholder.js      — empty-slot hint
      modals/
        modal.js            — generic dialog (header / body / footer / Esc / backdrop close)
        algorithm-modal.js  — single-level algorithm picker + params editor
        clustering-modal.js — multi-level clustering modal (used for Layer 2)
        panel-picker.js     — "Add panel" modal listing registered panel types
        layer-descriptors.js — per-workflow-node binding {label, openModal()}
    (engine modules unchanged: generation.js, blend/, clustering*, citations/, etc.)
```

Engine modules in `app/src/` (outside `ui/`) are pure functions and
never read or write `state` directly. The orchestrator in
`ui/engine.js` calls them with explicit args and stores results
back. This is the same separation the legacy `main.js` used; the
new shell just moves the orchestration to its own file.

---

## 2. State container (`ui/state.js`)

A single `state` object, mutated via `update(patch)` (shallow
merge) which fires every registered subscriber. All UI components
subscribe and re-render when their relevant slice changes.

### State shape

The shape evolves as features land; what's stable today:

```js
state = {
  // Data source (toy params / real load metadata)
  dataSource: { mode: "toy" | "real", config: {...} },

  // ── pipeline outputs (one slot per layer, null until run) ──
  genResult:             null,         // Layer 1
  _basePos:              null,         // Float32Array(n × 3)
  clusterLevels:         null,         // Layer 2 — multi-level array
  clusterResult:         null,         // alias for finest level (legacy panels)
  neighbourhoodResult:   null,         // taste-network internal
  tasteResult:           null,         // taste-network internal
  citationResult:        null,         // Layer 3
  citationLayout:        null,         // Layer 4 raw
  alignedCitationLayout: null,         // Layer 5a
  alignmentCorrelation:  NaN,          // Layer 5a quality metric
  bridgeAnalysis:        null,         // Layer 2.5 derivation (≥2 cluster levels only)

  // Bumps every time the pipeline produces fresh data.
  // Panels track this to know when to rebuild graphData.
  engineRevision: 0,

  // Per-layer state freshness for the workflow chart's status dots.
  layerStates: { data: "not-run", clustering: "not-run", … },

  // Per-layer params (per-algorithm shape — see "Layer params" below).
  layerParams: { neighbourhood, taste, citations, clustering, layout },

  // ── UI state ──
  panels: {
    primary:   { activeTabId, tabs: [{ id, type, config }] },
    secondary: { activeTabId, tabs: [{ id, type, config }] },
    bottom:    { activeTabId, tabs: [{ id, type, config }] },
  },
  selection: { type, level?, id, … },
  filter:    null,
  blend:     0.0,
};
```

### Layer params

Each layer's params live under `state.layerParams[layer]`. Shape
varies because layers evolved at different times:

- **Clustering** is multi-level:
  ```js
  layerParams.clustering = {
    method: "mutualKNN",
    levels: [
      { uid: "abc123", params: { mutualK: 5 }, scope: "global" | "within-parent" },
      ...
    ],
  }
  ```
  See `doc/multi-level.md` for the engine flow.

- **Layout** is single-level:
  ```js
  layerParams.layout = { method: "fruchterman-reingold", params: { ... } }
  ```

- **Neighbourhood / taste / citations** are flat param objects
  (defaults from each engine module's `default*Params()`).

### Actions

Mutations are typed helpers — `update(patch)` is the lowest-level
and rarely called directly:

| Action | What it does |
|--------|--------------|
| `update(patch)` | shallow-merge into state; notify subscribers |
| `subscribe(fn)` | register listener; returns unsubscribe |
| `setLayerState(layer, "fresh"\|"stale"\|"not-run"\|"error")` | drives workflow-chart status dots |
| `setActiveAlgorithm(layer, algoId)` | per-layer active algo (display only — engine reads `layerParams`) |
| `setBlend(α)` | clamps to [0, 1]; drives blend hook |
| `setDataSourceMode("toy"\|"real")` | mode toggle |
| `setToyParam(key, value)` | writes `dataSource.config[key]` |
| `setLayerParams(layer, params)` | replaces layer params wholesale |
| `setSelection({type, level?, id})` | selection sync target |
| `bumpEngineRevision()` | manual bump (engine usually does this) |
| **Panel/tab actions** | |
| `addTab(slot, type, config)` | append + activate; returns new tab id |
| `closeTab(slot, tabId)` | removes + auto-switches active to a neighbour |
| `setActiveTab(slot, tabId)` | switch focus |
| `setTabConfig(slot, tabId, partialConfig)` | merge into a tab's config (used by viewer-3d for camera settings, node-table for source) |

### Subscriber pattern

Every subsystem mounts then subscribes:

```js
import { getState, subscribe } from "./state.js";

export function mountFoo() {
  render(getState());
  subscribe((state) => render(state));
}
```

Subscribers are called with the full state on every `update()`.
Each subscriber decides what's changed (typically by tracking the
last-seen reference to a slice it cares about — `if (s.clusterResult
!== lastClusterResult) ...`).

---

## 3. Engine orchestrator (`ui/engine.js`)

Same lane structure as legacy `main.js`:

```
regenerate()    Layer 1 → generates basePos     → recluster()
    ↓
recluster()     Layer 2 (multi-level cascade)   → reneighbour()
    ↓
reneighbour()   taste-network stage 1            → retaste()
    ↓
retaste()       taste-network stages 2 + 3       → resample()
    ↓
resample()      Layer 3 final stage              → relayoutCitations()
    ↓
relayoutCitations()  Layer 4 + Layer 5a         (writes alignedCitationLayout +
                                                  alignmentCorrelation)
```

Each lane is its own exported function; calling a deeper lane
without re-running upstream is the granular re-run mechanism
(e.g., changing the layout algorithm calls `relayoutCitations()`
only, not the full `regenerate()`).

`recluster()` is multi-level and runs an extra step:
1. For each level in `layerParams.clustering.levels`, infer either
   globally (`scope === "global"`) or within parents
   (`scope === "within-parent"`, stitched via `clusterWithinParents()`).
2. After the loop, run `computeBridgeAnalysis()` if ≥ 2 levels exist.
3. Update `state.clusterLevels`, `state.clusterResult` (alias for
   the finest level), and `state.bridgeAnalysis`.

See `doc/multi-level.md` for the bridge analysis details.

`relayoutCitations()` writes both the raw layout output AND the
aligned-to-basePos version, plus the `alignmentCorrelation` quality
metric. Each call also bumps `engineRevision` so panels re-render.

---

## 4. Workflow chart (`ui/workflow-chart.js`)

SVG-rendered DAG of the pipeline, fixed in the left rail. One
node per layer. Clicking a node opens its modal (per
`ui/modals/layer-descriptors.js`).

### Status dots

Each node shows a small dot whose colour reads from
`state.layerStates[layer]`:

- ✓ green — `"fresh"` (computed, cached)
- ⚠ yellow — `"stale"` (upstream changed, awaiting recompute)
- ⛔ red — `"error"`
- ◯ grey — `"not-run"`

### Algorithm label

Below each method node's title is a small monospace line showing
the *active* algorithm. The label is read directly from
`layerParams[layer].method` (single source of truth — there is no
shadow `activeAlgorithm` slot any more; the workflow chart computes
the label on the fly via `activeAlgorithmFor(state, nodeId)`).

For the clustering node, the label is `<method> · N levels` when
N > 1, plain `<method>` otherwise.

### Node click → modal

`onNodeClick(node)` calls `getLayerDescriptor(node.id).openModal()`.
The descriptor knows which modal to open (clustering uses the
multi-level modal; layout uses the single-level algorithm modal).

---

## 5. Panel system (`ui/panel-system.js`)

Three slots — `primary`, `secondary`, `bottom` — each holds an
array of tabs. One tab is active at a time per slot.

### Tab strip

For each tab: clickable label + small × close button. After all
tabs: a `+` button that opens the **panel-picker modal** showing
registered panel types. Far right of the strip is the slot label
(italic, non-interactive).

### Panel registry (`panels/registry.js`)

```js
{
  id:          "viewer-3d",
  label:       "3D viewer",
  description: "Live blend visualisation; per-frame interpolation between basePos and aligned citation layout.",
  mount:       (container, state, config, tabContext) => ({ update, destroy }),
  singleton:   true,    // optional — picker filters this if already mounted somewhere
}
```

The panel module exports `ID`, `LABEL`, `DESCRIPTION`, `mount`, and
optionally `SINGLETON`. The registry's `register()` reads each.

### Panel module contract

```js
export function mount(container, state, config = {}, tabContext = null) {
  // tabContext = { slot, tabId } — used for setTabConfig persistence

  // Build DOM into `container`. Panel may subscribe to state itself
  // (panel-system also calls update() on every subscriber tick).

  return {
    update(state) { /* re-render based on new state */ },
    destroy()     { /* clean up timers, GL contexts, etc. */ },
  };
}
```

The panel-system tracks per-slot `{ panelsRef, instance, tabId }`.
Tabs are re-rendered only when `state.panels[slot]` reference
changes (cheap). Active panel is re-mounted only when its tab id
changes; otherwise its `update()` runs every state tick.

### Built-in panels

| ID | Panel | Notes |
|----|-------|-------|
| `placeholder` | shows "No panel — click + to add" | used for empty slots |
| `viewer-3d` | live blend; colour-mode + camera-speed overlays | **singleton** (one WebGL ctx max) |
| `node-table` | mode-aware legend (cluster / origin / inDeg / t / bridge / boundaryScore) | see "Node table" below |

### Adding a new panel type

1. Create `panels/<id>.js` exporting `ID`, `LABEL`, `DESCRIPTION`,
   `mount`, optionally `SINGLETON`.
2. Register in `panels/registry.js`:
   ```js
   import * as MyPanel from "./my-panel.js";
   register(MyPanel);
   ```

The panel-picker modal automatically lists it. No other file
changes needed.

---

## 6. Modal infrastructure (`ui/modals/`)

### `modal.js` — generic dialog

```js
const m = openModal({
  title:   "...",
  body:    domNodeOrFunction,
  actions: [
    { label: "Cancel" },
    { label: "Apply", primary: true, onClick: () => { /* commit */ } },
  ],
  onClose: () => { /* optional cleanup */ },
});
m.close();
```

Behaviour:
- Mounts into `#modal-root`.
- Backdrop click closes.
- Escape key closes (top-most modal only, if nested).
- Action `onClick` may return `false` to keep the modal open;
  any other return value (including `undefined`) closes.

### `algorithm-modal.js` — single-level

Used for layers with one parameter set per algorithm (citation
layout). Renders:
- Algorithm dropdown
- Description callout
- Params editor built from the algorithm's `modalSchema`
- Cancel / Apply

### `clustering-modal.js` — multi-level

Same as algorithm-modal but with N levels stacked, each with its
own params + (for L1+) a scope toggle and × close button. `+ Add
level` appends a new level. See `doc/multi-level.md`.

### `panel-picker.js`

Lists registered panel types when the user clicks the `+` button
in any tab strip. Filters singletons that are already mounted
somewhere (via `state.panels` scan).

### `layer-descriptors.js`

Maps workflow-chart node IDs to per-layer modal openers:

```js
getLayerDescriptor("clustering") → {
  label: "Configure: Clustering",
  openModal: () => openClusteringModal(...),
  listAlgos, getActive, applyChange,
}
```

Adding a new pluggable layer = one descriptor function + a
workflow-chart node entry.

---

## 7. Gradients module (`ui/gradients.js`)

Single source of truth for continuous-colour palettes shared by
viewer-3d (per-node colouring) and node-table (per-row swatches +
legend bar). Exports:

- Stop arrays: `T_STOPS`, `INDEG_STOPS` (viridis), `BOUNDARY_STOPS`
- Colour functions: `tGradient(t)`, `inDegGradient(t)`,
  `boundaryScoreGradient(t)` — all return `rgb(r, g, b)` strings
- `cssLinearGradient(stops)` — for the legend bar's CSS background

If a palette ever needs to change, edit the stop array once;
both surfaces pick it up automatically.

---

## 8. Selection types

`state.selection` is typed:

```js
{ type: null, id: null }                                   // no selection
{ type: "cluster", level: N, id: cid }                     // cluster at level N
{ type: "origin",  id: oid }                               // generator origin
{ type: "node",    id: nodeId }                            // single paper / node
{ type: "tBin",    binIdx: i }                             // time bin (no viewer effect yet)
```

`viewer-3d`'s `nodeColour` dim-routes by type; the same node match
function gates dimming for cluster / origin / node. Adding a new
selection type = one new branch in `nodeMatchesSelection()`.

The node-table's row builders set the `_select()` thunk per row;
clicking a row calls `setSelection(thunk())`. Clicking the same
row again toggles back to `{type: null, id: null}`.

---

## 9. Node table (the legend) — `panels/node-table.js`

The right-side panel that doubles as a legend for whatever's
colouring the 3D viewer. Source dropdown at top:

| Source | What rows represent |
|--------|---------------------|
| `auto` | follows the active 3D viewer's `colourMode` |
| `cluster:finest` | one row per cluster at the finest level |
| `cluster:N` | one row per cluster at level N |
| `bridge` | one row per bridge fine-cluster (≥2 coarse parents) |
| `boundaryScore` | one row per fine cluster sorted by `1 − dominantFraction` |
| `origin` | one row per Gaussian-mixture origin |
| `t` | 10 t-bins |
| `inDeg` | top-50 nodes by citation in-degree |

### Per-source schema

Each row builder returns:

```js
{
  title:       string,             // displayed in the headbar status
  unitLabel:   string,             // for the footer's "X bridges" / "X clusters"
  columns: [{ key, label, kind: "colour"|"int"|"float"|"text", sortable }],
  rows: [{ _key, _select, [colKey]: value, ... }],
  defaultSort: { key, dir },
  selectionKey: (row, sel) => boolean,    // for highlight matching
  gradient?: { stops, min, max, label },  // optional — renders the legend bar
}
```

### Adding a new source

1. Write a builder fn in `node-table.js` returning the shape above.
2. Add an entry to `sourceOptionsFor(state)` (with whatever
   availability check makes sense — e.g. only if `bridgeAnalysis`
   exists).
3. Wire it in `buildTableData(s, source)`.

If the source is a continuous gradient, return the optional
`gradient` field — the table renders a `LABEL · MIN ▬▬▬ MAX`
legend bar at the top. Hidden for categorical sources.

---

## 10. Patterns: how to add things

### A new clustering algorithm

1. New module `app/src/<algo>.js` exporting an `infer(genResult, params)`.
2. Entry in `app/src/clustering-registry.js`:
   `{ id, label, description, allowsNoise, defaultParams, infer, modalSchema }`.

The clustering modal's algorithm dropdown auto-lists it. The
multi-level engine cascade calls it. The workflow chart updates
its label. The node-table's `cluster:N` source still works.

### A new colour mode

1. Add an entry to `getColourModeOptions(state)` in `viewer-3d.js`.
2. Add a branch in `baseColourFor(n, state, mode)` returning the
   colour string.
3. (Optional) Add a matching node-table source via `sourceOptionsFor`
   so the legend tracks the viewer.
4. (Optional) If continuous-gradient, return a `gradient` descriptor
   from the source builder.

### A new panel type

See §5 above.

### A new pluggable layer

1. New module in `app/src/<layer>/registry.js` (registry pattern).
2. New descriptor in `ui/modals/layer-descriptors.js` — bind
   `openModal()` to the right modal kind (single-level or
   multi-level), implement `listAlgos / getActive / applyChange`.
3. Add the workflow chart node to `NODES` array in
   `workflow-chart.js`.
4. Add an engine lane in `ui/engine.js` that runs this layer + a
   case in `activeAlgorithmFor()` for the chart's algo label.

---

## 11. Adding to the docs

When a new layer or major feature lands:

- Add a section here (or a new `doc/<feature>.md`) describing the
  state shape, contract, and UI surfaces.
- Update `doc/dynamics.md` (the layer index) if it's a new pipeline
  layer.
- Update `doc/plan.md`'s sequencing if the feature was on the plan.

Documentation conventions:
- Single source of truth per concept. Cross-link rather than
  duplicate.
- Code excerpts use the actual file's symbols (don't invent fake
  function names just for the doc).
- Patterns ("how to add X") belong in this file or the relevant
  layer doc; specs belong in their own files.
