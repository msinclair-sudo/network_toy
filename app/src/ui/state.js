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
  dataSource: {
    mode: "toy",           // "toy" | "real"
    config: {
      // toy params
      seed: 42,
      nodeCount: 400,
      origins: 6,
      spread: 1.0,
      density: 0.3,
      intraRate: 0.5,
      crossRate: 0.2,
      // real params (populated when mode === "real")
      datasetName: null,
      paperCount: null,
      edgeCount: null,
      embeddingDim: null,
    },
  },

  // ── pipeline outputs (one per layer; null until run) ─────────
  // Stored flat at state root for direct getter access from the
  // blend hook and per-panel rendering — mirrors the legacy main.js
  // shape so engine modules can be ported without restructuring.
  genResult:             null,    // Layer 1 output: {origins, nodes:[{id, basePos, t, originId}]}
  _basePos:              null,    // Float32Array(n × 3) — flattened basePos, blend force input
  clusterResult:         null,    // Layer 2 output: ClusterResult contract
  neighbourhoodResult:   null,    // taste-network internal: {neighbourhoods, nodeNeighbourhood}
  tasteResult:           null,    // taste-network internal: {tasteByNeighbourhood, tasteByCluster}
  citationResult:        null,    // Layer 3 output: CitationResult contract
  citationLayout:        null,    // Layer 4 output: Float32Array(n × 3) raw layout positions
  alignedCitationLayout: null,    // Layer 5a output: Float32Array(n × 3) — blend force input
  alignmentCorrelation:  NaN,     // Layer 5a quality metric ∈ [0, 1]

  // Bumps every time the pipeline runs (full or partial).
  // Panels watch this to know when to rebuild their cached views.
  engineRevision:        0,

  // Layer-specific algorithm params. Populated lazily on first
  // pipeline run from each registry's defaultParams().
  layerParams: {
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
    "dimred":     "umap",       // (registry not yet built)
    "clustering": "hdbscan",    // existing
    "citations":  "taste-network",   // toy default
    "layout":     "mds",         // existing
  },

  // ── UI state ─────────────────────────────────────────────────
  panels: {
    primary:   { type: "viewer-3d",   config: { rotateSpeed: 0.3, zoomSpeed: 0.3, panSpeed: 0.3, smoothMotion: false } },
    secondary: { type: "placeholder", config: { label: "Cluster table", hint: "cluster-table panel — slice 3 of the build" } },
    bottom:    { type: "placeholder", config: { label: "Tables / sweep results", hint: "configurable panel — wire any registered panel type here" } },
  },
  selection: { type: null, id: null },
  filter: null,
  blend: 0.0,
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

// Helpers for common nested updates.
export function setPanel(slot, type, config = {}) {
  update({
    panels: { ...state.panels, [slot]: { type, config } },
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

export function setDataSourceMode(mode) {
  update({
    dataSource: { ...state.dataSource, mode },
  });
}

export function setToyParam(key, value) {
  update({
    dataSource: {
      ...state.dataSource,
      config: { ...state.dataSource.config, [key]: value },
    },
  });
}

export function bumpEngineRevision() {
  update({ engineRevision: state.engineRevision + 1 });
}

export function setLayerParams(layer, params) {
  update({
    layerParams: { ...state.layerParams, [layer]: params },
  });
}
