// Centralised state container.
//
// Tiny, vanilla, no framework. Subscribers register a function that
// runs whenever state changes. Mutations go through `update(patch)`
// which shallow-merges and notifies subscribers.
//
// State shape evolves as components come online. Slice naming is
// stable (so panels can subscribe to `state.clustering` even before
// a clustering module exists).
//
// See doc/ui.md §6.

const state = {
  // ── data source ──────────────────────────────────────────────
  // mode mirrors activeAlgorithm.dataSource (kept for backward-compat
  // with code that still reads dataSource.mode). Per-mode configs are
  // stashed under .configs so switching modes preserves each side's
  // user state. Citation-pacing knobs (density / intra / cross) live
  // alongside the toy generator's seed/nodeCount/origins/spread because
  // the data panel owns them UX-wise; the engine plumbs them into
  // Layer 3 params on reingest.
  dataSource: {
    mode: "toy",           // "toy" | "real"; mirrors activeAlgorithm.dataSource
    configs: {
      toy: {
        seed:      42,
        nodeCount: 400,
        origins:   6,
        spread:    1.0,
        density:   0.3,
        intraRate: 0.5,
        crossRate: 0.2,
      },
      real: {
        subset: "dev_subset_1000",
      },
    },
  },

  // ── pipeline outputs (one per layer; null until run) ─────────
  // Stored flat at state root for direct getter access from the
  // blend hook and per-panel rendering — mirrors the legacy main.js
  // shape so engine modules can be ported without restructuring.
  genResult:             null,    // Layer 1 output (data-source result):
                                  //   {nodes:[{id, t, basePos?, originId?, paperId?}], origins?, embedding?, basePos?}
                                  //   "genResult" is kept as the field name for legacy reasons; semantically
                                  //   it's the active data source's output (toy or real).
  _basePos:              null,    // Float32Array(n × 3) — flattened basePos, blend force input.
                                  //   Sourced from genResult.basePos / nodes[i].basePos directly (toy)
                                  //   or from Layer 1.5's viz sub-stage (real).
  _basePos2d:            null,    // Float32Array(n × 2) — viewer-2d input.
                                  //   Populated only when Layer 1.5's viz2d sub-stage produces a 2-d
                                  //   output (e.g. UMAP n_components=2). Null otherwise → viewer-2d
                                  //   shows its empty-state hint.
  embedding:             null,    // Real-data Layer 1 output: {d, data:Float32Array(n*d)} — high-dim
                                  //   feature vectors, set when the active data source supplied them.
                                  //   Layer 1.5 reads this as its noise-stage input. Null in toy mode.
  rawCitationEdges:      null,    // Citation graph cached at ingest time, populated by data sources
                                  //   that can supply edges directly (today: real-data via
                                  //   produceReal()). Flat number[] of length 2|E| in [src, dst, src,
                                  //   dst, …] form. Read-only outside the data-source layer —
                                  //   consumers: dimred fusion stage, Layer 3 imported-edges. Null in
                                  //   toy mode (taste-network generates citations later in the
                                  //   pipeline; fusion stage falls through as identity).
  dimredResult:          null,    // Layer 1.5 output: {method, params, n, d, data:Float32Array(n*d)}
                                  //   Layer 2 reads from this for distance computations.
  dimredResultPreFusion: null,    // Layer 1.5 *without* fusion applied — same shape as dimredResult.
                                  //   Populated only when fusion is non-identity; lets the cluster
                                  //   lane produce a parallel pre-fusion clusterLevels for A/B colour
                                  //   comparison. Null when fusion=identity (nothing to compare).
  _basePosPreFusion:     null,    // Float32Array(n × 3) — viz UMAP-3 result on the pre-fusion (noise-
                                  //   stage) embedding. Drives the fusion-comparison slider in the
                                  //   blend hook; nested with the existing basePos↔citation blend.
                                  //   Null when fusion=identity OR fusion is set but the cascade
                                  //   hasn't produced one yet.
  clusterLevels:         null,    // Layer 2 output: [{uid, scope, clusterResult}] one per level
  clusterLevelsPreFusion:null,    // Same shape as clusterLevels, but computed on dimredResultPreFusion.
                                  //   Drives the "Color by pre-fusion clusters" colour mode. Null when
                                  //   pre-fusion compute didn't run.
  clusterResult:         null,    // Backward-compat alias for the FINEST level's clusterResult
                                  //   (used by panels that aren't yet level-aware)
  clusterResultPreFusion:null,    // Backward-compat alias for clusterLevelsPreFusion's finest level.
  neighbourhoodResult:   null,    // taste-network internal: {neighbourhoods, nodeNeighbourhood}
  tasteResult:           null,    // taste-network internal: {tasteByNeighbourhood, tasteByCluster}
  citationResult:        null,    // Layer 3 output: CitationResult contract
  citationLayout:        null,    // Layer 4 output: Float32Array(n × 3) raw layout positions
  alignedCitationLayout: null,    // Layer 5a output: Float32Array(n × 3) — blend force input
  alignmentCorrelation:  NaN,     // Layer 5a quality metric ∈ [0, 1]

  // Derived analysis on top of clusterLevels. Null when fewer than 2
  // levels exist. See bridge-analysis.js for shape.
  bridgeAnalysis:        null,

  // Which (fineLevel, coarseLevel) pair the bridge analysis runs on.
  // When a field is null/invalid, the engine clamps it to the deepest
  // valid pair (fineLevel = last, coarseLevel = last - 1). The bridge
  // table panels surface dropdowns that write to this slice.
  bridgeConfig:          { fineLevel: null, coarseLevel: null },

  // Bumps every time the pipeline runs (full or partial).
  // Panels watch this to know when to rebuild their cached views.
  engineRevision:        0,

  // Layer-specific algorithm params. Populated lazily on first
  // pipeline run from each registry's defaultParams().
  layerParams: {
    dimred:        null,    // { noise: {method, params}, compression: {method, params} }
                            //   Layer 1.5 has two sequential stages; the engine runs them
                            //   in order. Default is identity for both = pass-through.
    neighbourhood: null,
    taste:         null,
    citations:     null,
    clustering:    null,    // { method, byAlgo: { algoId: params } }
    layout:        null,    // { method, params }
  },

  // ── pipeline freshness ───────────────────────────────────────
  // states: "not-run" | "stale" | "fresh" | "error"
  layerStates: {
    "data":      "not-run",
    "dimred":    "not-run",
    "clustering":"not-run",
    "citations": "not-run",
    "layout":    "not-run",
    "alignment": "not-run",
    "blend":     "not-run",
  },

  // ── active algorithm per pluggable layer ─────────────────────
  // populated as registries come online; placeholders for now
  activeAlgorithm: {
    "dataSource": "toy",         // "toy" | "real"; selects which datasource registry entry runs
    // dimred has three stages now (noise + compression + viz); the workflow
    // chart reads layerParams.dimred directly to summarise. activeAlgorithm
    // here holds only the compression-side method as a single legacy label.
    "dimred":     "identity",
    "clustering": "hdbscan",    // existing
    "citations":  "taste-network",   // toy default
    "layout":     "mds",         // existing
  },

  // ── UI state ─────────────────────────────────────────────────
  // Each slot holds an array of tabs; one is active at a time.
  // Tabs are added/closed via the +/× buttons in the tab strip.
  panels: {
    primary: {
      activeTabId: "p-viewer-3d",
      tabs: [
        {
          id:     "p-viewer-3d",
          type:   "viewer-3d",
          config: {
            rotateSpeed: 0.3, zoomSpeed: 0.3, panSpeed: 0.3, smoothMotion: false,
            colourMode:  "cluster:finest",
          },
        },
      ],
    },
    secondary: {
      activeTabId: "s-node-table",
      tabs: [
        { id: "s-node-table", type: "node-table", config: { source: "auto" } },
      ],
    },
    bottom: {
      activeTabId: null,
      tabs: [],
    },
  },
  selection: { type: null, id: null },
  filter: null,
  blend: 0.0,
  // Fusion-comparison slider (Layer 1.5 A/B). Interpolates basePos
  // between pre-fusion (semantic-only) and post-fusion (citation-aware)
  // positions. Inert when _basePosPreFusion is null — i.e. fusion is
  // identity (toy mode default) OR pre-fusion compute hasn't run yet.
  // 0 = pre-fusion semantic, 1 = post-fusion citation-aware embedding.
  fusionBlend: 1.0,

  // ── viewer-3d display toggles ────────────────────────────────
  // Which edge layers to draw, and their per-layer styling. Mirrors
  // the legacy main.js `state.view.*` shape so the colour / opacity
  // logic ports verbatim. All default OFF — the 3D viewer is dense
  // enough already; the user opts in to each overlay.
  //
  //   showCitations — Layer 3 edges (citationResult.citations)
  //   showBase      — semantic-distance edges (top-K closest pairs in basePos)
  //   showStructure — clusterResult.structureEdges (mutual-kNN / MST / top-k)
  //   citArrows     — directional arrowheads on citation edges only
  //   citOpacity    — 0..1 linear opacity for citation links
  //   baseDensity   — 0..1 fraction of all n*(n-1)/2 pairs to draw as base edges
  view: {
    showCitations: false,
    showBase:      false,
    showStructure: false,
    citArrows:     false,
    citOpacity:    0.15,
    baseDensity:   0.02,
    // Per-edge-kind colours. Defaults match the EDGE_STYLE table in
    // viewer-3d.js; the picker writes hex strings back here and the
    // renderer reads them on every linkMaterial/linkColour call.
    citColour:        "#8a8a8a",
    baseColour:       "#5a6878",
    structureColour:  "#5dd39e",
  },

  // ── persistence ──────────────────────────────────────────────
  // Project name from the most-recent save / load. Used by the
  // File ▾ menu's "Save" action (when null, falls through to
  // "Save as" which prompts for a name).
  projectName: null,

  // Latest results from the Cluster modal's Validate + Optimise
  // tabs. Persisted into save files so that reloading a project
  // restores the eval results without re-running.
  // Cleared by recluster() — stale results don't survive a
  // clustering config change.
  evalResults: {
    validate: null,   // {perCluster, aggregate, bootstrapsRun, settings, timestamp}
    optimise: null,   // {ranked, top, totalConfigs, completed, settings, scorerLabel, timestamp, runtime}
  },

  // ── Global busy queue (§6.13). ──────────────────────────────────
  // Drives the bottom status bar. null when idle. When a job runs:
  //   current: { id, label, since }
  //   queue:   [{ id, label }, …]  ← jobs waiting their turn
  // Mutated only through actions in ui/busy.js (enqueueBusy +
  // setBusyLabel) so the queue stays consistent with the in-memory
  // pending list.
  busy: null,
};

const subscribers = new Set();

export function getState() {
  return state;
}

// Shallow-merge patch into state and notify subscribers.
// For nested updates pass a patch with the nested key replaced
// (e.g. update({ panels: { ...state.panels, primary: {...} } })).
export function update(patch) {
  Object.assign(state, patch);
  for (const fn of subscribers) {
    try { fn(state); }
    catch (e) { console.error("subscriber threw:", e); }
  }
}

export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// ── Panel/tab helpers ──────────────────────────────────────────────
// Slot shape: { activeTabId, tabs: [{ id, type, config }] }
// Each tab has a unique id within the slot; close removes by id and
// auto-switches active to a neighbour. Add returns the new tab id.

function genTabId(slot) {
  return `${slot}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function addTab(slot, type, config = {}) {
  const cur = state.panels[slot];
  if (!cur) throw new Error(`unknown slot "${slot}"`);
  const id = genTabId(slot);
  update({
    panels: {
      ...state.panels,
      [slot]: {
        activeTabId: id,
        tabs: [...cur.tabs, { id, type, config }],
      },
    },
  });
  return id;
}

export function closeTab(slot, tabId) {
  const cur = state.panels[slot];
  if (!cur) return;
  const tabs = cur.tabs.filter(t => t.id !== tabId);
  let activeTabId = cur.activeTabId;
  if (activeTabId === tabId) {
    activeTabId = tabs.length > 0 ? tabs[tabs.length - 1].id : null;
  }
  update({
    panels: { ...state.panels, [slot]: { activeTabId, tabs } },
  });
}

export function setActiveTab(slot, tabId) {
  const cur = state.panels[slot];
  if (!cur || cur.activeTabId === tabId) return;
  if (!cur.tabs.some(t => t.id === tabId)) return;
  update({
    panels: { ...state.panels, [slot]: { ...cur, activeTabId: tabId } },
  });
}

export function setTabConfig(slot, tabId, partialConfig) {
  const cur = state.panels[slot];
  if (!cur) return;
  const tabs = cur.tabs.map(t =>
    t.id === tabId ? { ...t, config: { ...t.config, ...partialConfig } } : t
  );
  update({
    panels: { ...state.panels, [slot]: { ...cur, tabs } },
  });
}

export function setLayerState(layer, layerState) {
  update({
    layerStates: { ...state.layerStates, [layer]: layerState },
  });
}

export function setActiveAlgorithm(layer, algoId) {
  update({
    activeAlgorithm: { ...state.activeAlgorithm, [layer]: algoId },
  });
}

export function setBlend(alpha) {
  update({ blend: Math.max(0, Math.min(1, +alpha || 0)) });
}

export function setFusionBlend(alpha) {
  update({ fusionBlend: Math.max(0, Math.min(1, +alpha || 0)) });
}

// Switch the active data source. Mirrors mode into both the legacy
// dataSource.mode field and the activeAlgorithm.dataSource registry-
// active key so consumers reading either keep working. Per-mode
// configs are stashed under dataSource.configs[mode] and preserved
// across switches.
export function setDataSourceMode(mode) {
  update({
    dataSource:      { ...state.dataSource, mode },
    activeAlgorithm: { ...state.activeAlgorithm, dataSource: mode },
  });
}

// Update a key in a specific source's config bag. When `mode` is
// omitted, writes to whatever's currently active.
export function setDataSourceConfig(key, value, mode) {
  const m   = mode || state.dataSource.mode;
  const cur = state.dataSource.configs[m] || {};
  update({
    dataSource: {
      ...state.dataSource,
      configs: { ...state.dataSource.configs, [m]: { ...cur, [key]: value } },
    },
  });
}

// Always targets the toy config — the topbar's seed input is toy-only,
// so it shouldn't accidentally write into the real config when the
// user is in real mode.
export function setToyParam(key, value) {
  setDataSourceConfig(key, value, "toy");
}

export function bumpEngineRevision() {
  update({ engineRevision: state.engineRevision + 1 });
}

export function setLayerParams(layer, params) {
  update({
    layerParams: { ...state.layerParams, [layer]: params },
  });
}

export function setSelection(selection) {
  update({ selection: selection || { type: null, id: null } });
}

export function setProjectName(name) {
  update({ projectName: name || null });
}

export function setValidateResult(result) {
  update({ evalResults: { ...state.evalResults, validate: result || null } });
}

export function setOptimiseResult(result) {
  update({ evalResults: { ...state.evalResults, optimise: result || null } });
}

export function clearEvalResults() {
  update({ evalResults: { validate: null, optimise: null } });
}

// Update the bridge analysis pair (fineLevel and/or coarseLevel).
// Pass only the fields you want to change — others are preserved.
// The engine reads this slice on every recluster and re-derives
// bridgeAnalysis; callers also need to invoke recomputeBridgeAnalysis()
// when they want an immediate refresh without a full recluster.
export function setBridgeConfig(partial) {
  update({
    bridgeConfig: { ...state.bridgeConfig, ...(partial || {}) },
  });
}

// Patch the viewer-3d display flags (which edge layers + their styling).
// Partial update — pass only the fields you want to change. Triggers
// a state notification so viewer-3d picks up the new flags on its
// next update() callback.
export function setView(partial) {
  update({ view: { ...state.view, ...(partial || {}) } });
}
