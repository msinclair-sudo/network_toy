// Engine orchestrator for the new shell.
//
// Mirrors the legacy main.js pipeline (regenerate → recluster →
// reneighbour → retaste → resample → relayoutCitations) but
// writes results into the new state container instead of a local
// closure. Modules from app/src/ (generation, clustering*, citations*,
// blend/align, citation-layout/) are unchanged — this is just the
// new glue layer.
//
// Each public function below = one re-run lane. Downstream functions
// are called automatically so a parameter change at any layer
// cascades to the layout + alignment without redoing upstream work.

import { generate }                                              from "../generation.js";
import { getAlgorithm as getClusteringAlgorithm,
         listAlgorithms as listClusteringAlgorithms }            from "../clustering-registry.js";
import { validateClusterResult }                                 from "../contracts/cluster.js";
import { inferNeighbourhoods, defaultNeighbourhoodParams }       from "../neighbourhoods.js";
import { buildCitationTaste, defaultTasteParams }                from "../citation-taste.js";
import { generateCitations, defaultCitationParams }              from "../citations.js";
import { getAlgorithm as getCitationLayoutAlgorithm }            from "../citation-layout/registry.js";
import { alignByComponent }                                      from "../blend/align.js";
import { update, getState, setLayerState }                       from "./state.js";

// Initialise layerParams from registry defaults on first call.
function ensureLayerParams() {
  const s = getState();
  const lp = s.layerParams;
  let dirty = false;
  const next = { ...lp };

  if (!lp.neighbourhood) { next.neighbourhood = defaultNeighbourhoodParams(); dirty = true; }
  if (!lp.taste)         { next.taste         = defaultTasteParams();         dirty = true; }
  if (!lp.citations)     { next.citations     = defaultCitationParams();      dirty = true; }
  if (!lp.clustering) {
    // Build a per-algorithm params map so the toy can swap algorithms
    // without losing each algorithm's tuned params (matches the
    // legacy state.clusterParams.byAlgo shape).
    const byAlgo = {};
    for (const a of listClusteringAlgorithms()) byAlgo[a.id] = a.defaultParams();
    next.clustering = {
      method: "mutualKNN",                  // legacy default
      byAlgo,
    };
    dirty = true;
  }
  if (!lp.layout) {
    next.layout = { method: "fruchterman-reingold", params: {} };
    dirty = true;
  }

  if (dirty) update({ layerParams: next });
}

function activeClusterAlgorithm() {
  const s = getState();
  return getClusteringAlgorithm(s.layerParams.clustering.method);
}

function activeClusterAlgorithmParams() {
  const s = getState();
  return s.layerParams.clustering.byAlgo[s.layerParams.clustering.method];
}

/* ── public API: pipeline lanes ─────────────────────────────────────── */

// Full re-run from Layer 1 down. Used by Generate ▶ and on boot.
export function regenerate() {
  ensureLayerParams();
  const s = getState();
  const params = {
    seed:           s.dataSource.config.seed,
    nodeCount:      s.dataSource.config.nodeCount,
    pointsOfOrigin: s.dataSource.config.origins,
    spreadScale:    s.dataSource.config.spread,
  };

  // Plumb the data-panel's fast-iteration toy controls
  // (density / intra / cross) into the citation layer's params.
  // The data panel "owns" these knobs from a UX perspective even
  // though they're algorithmically Layer 3 params.
  const cur = getState();
  update({
    layerParams: {
      ...cur.layerParams,
      citations: {
        ...cur.layerParams.citations,
        density:   s.dataSource.config.density,
        intraRate: s.dataSource.config.intraRate,
        crossRate: s.dataSource.config.crossRate,
      },
    },
  });

  const genResult = generate(params);

  // Flatten basePos into a Float32Array(n × 3) for the blend hook
  // and the alignment pass.
  const n = genResult.nodes.length;
  const bp = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = genResult.nodes[i].basePos;
    bp[i*3] = p[0]; bp[i*3+1] = p[1]; bp[i*3+2] = p[2];
  }

  update({ genResult, _basePos: bp });
  setLayerState("data", "fresh");
  recluster();
}

// Layer 2.
export function recluster() {
  const s = getState();
  if (!s.genResult) return;
  const algo = activeClusterAlgorithm();
  const params = activeClusterAlgorithmParams();
  const clusterResult = algo.infer(s.genResult, params);
  validateClusterResult(clusterResult, s.genResult.nodes.length, {
    allowNoise: !!algo.allowsNoise,
  });
  update({ clusterResult });
  setLayerState("clustering", "fresh");
  reneighbour();
}

// taste-network's internal stage 1.
export function reneighbour() {
  const s = getState();
  if (!s.genResult || !s.clusterResult) return;
  const neighbourhoodResult = inferNeighbourhoods(
    s.genResult, s.clusterResult, s.layerParams.neighbourhood,
  );
  update({ neighbourhoodResult });
  retaste();
}

// taste-network's internal stages 2 + 3.
export function retaste() {
  const s = getState();
  if (!s.clusterResult || !s.neighbourhoodResult) return;
  const tasteResult = buildCitationTaste(
    s.clusterResult, s.neighbourhoodResult, s.layerParams.taste,
  );
  update({ tasteResult });
  resample();
}

// Layer 3 final stage + cascade.
export function resample() {
  const s = getState();
  if (!s.genResult || !s.clusterResult || !s.neighbourhoodResult || !s.tasteResult) return;
  const citationResult = generateCitations(
    s.genResult, s.clusterResult, s.neighbourhoodResult, s.tasteResult, s.layerParams.citations,
  );
  update({ citationResult });
  setLayerState("citations", "fresh");
  relayoutCitations();
}

// Layers 4 + 5a.
export function relayoutCitations() {
  const s = getState();
  if (!s.genResult || !s.citationResult) return;
  const n = s.genResult.nodes.length;
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = s.genResult.nodes[i].t;

  const layoutAlgo = getCitationLayoutAlgorithm(s.layerParams.layout.method);
  const edges = s.citationResult.citations.map(c => [c.source, c.target]);
  const citationLayout = layoutAlgo.compute({
    n, edges, t,
    seed:   s.layerParams.citations.samplingSeed,
    params: s.layerParams.layout.params,
  });

  const alignResult = alignByComponent({
    basePos:     s._basePos,
    citationPos: citationLayout,
    edges,
    n,
  });

  update({
    citationLayout,
    alignedCitationLayout: alignResult.aligned,
    alignmentCorrelation:  alignResult.correlation,
    engineRevision:        getState().engineRevision + 1,
  });
  setLayerState("layout", "fresh");
  setLayerState("alignment", "fresh");
  setLayerState("blend", "fresh");
}
