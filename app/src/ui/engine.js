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
import { computeBridgeAnalysis }                                 from "./bridge-analysis.js";
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
    // Multi-level clustering: each level holds its own params and a
    // scope flag ("global" = re-cluster the whole dataset; "within-
    // parent" = cluster within each previous-level cluster's members).
    // Default is one global level with the algorithm's defaults — same
    // observable behaviour as before. Sub-clustering is opt-in via the
    // modal's + Add level.
    const algoId = "mutualKNN";
    const algo = getClusteringAlgorithm(algoId);
    next.clustering = {
      method: algoId,
      levels: [
        { uid: makeUid(), params: algo.defaultParams(), scope: "global" },
      ],
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

function makeUid() {
  return Math.random().toString(36).slice(2, 10);
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

// Layer 2 — multi-level.
// For each level: scope === "global" runs the algorithm on the whole
// dataset; scope === "within-parent" runs it once per parent cluster's
// member set and stitches the results into a globally-numbered
// ClusterResult. The first level is always treated as global (it has
// no parent). Backward-compat: state.clusterResult is set to the
// finest (last) level's ClusterResult so panels not yet level-aware
// keep working.
export function recluster() {
  const s = getState();
  if (!s.genResult) return;
  const algo = activeClusterAlgorithm();
  const cfg = s.layerParams.clustering;
  const allowNoise = !!algo.allowsNoise;
  const n = s.genResult.nodes.length;

  if (!cfg || !cfg.levels || cfg.levels.length === 0) return;

  const levels = [];
  let parent = null;     // ClusterResult of the previous level

  for (let i = 0; i < cfg.levels.length; i++) {
    const lvl = cfg.levels[i];
    const isGlobal = (i === 0) || lvl.scope === "global";
    let cr;
    if (isGlobal) {
      cr = algo.infer(s.genResult, lvl.params);
    } else {
      cr = clusterWithinParents(algo, s.genResult, parent, lvl.params);
    }
    validateClusterResult(cr, n, { allowNoise });
    levels.push({ uid: lvl.uid, scope: isGlobal ? "global" : "within-parent", clusterResult: cr });
    parent = cr;
  }

  const finest = levels[levels.length - 1].clusterResult;
  // Derived: bridge analysis pairs the finest level with the level
  // above. Null when only one level exists.
  const bridgeAnalysis = computeBridgeAnalysis(levels);

  update({
    clusterLevels: levels,
    clusterResult: finest,
    bridgeAnalysis,
  });
  setLayerState("clustering", "fresh");
  reneighbour();
}

// Run the clustering algorithm separately on each parent cluster's
// member set, then stitch into a single ClusterResult with global
// IDs. Output cluster IDs are renumbered per parent so they're
// contiguous and non-overlapping. Singletons or empty parents become
// trivial single-cluster outputs.
function clusterWithinParents(algo, genResult, parent, params) {
  const n = genResult.nodes.length;
  const numParents = parent.clusters.length;
  const nodeCluster = new Int32Array(n);
  const clusters = [];
  const structureEdges = [];
  let nextId = 0;

  // Group nodes by parent cluster id.
  const byParent = Array.from({ length: numParents }, () => []);
  for (let i = 0; i < n; i++) byParent[parent.nodeCluster[i]].push(i);

  for (let p = 0; p < numParents; p++) {
    const ids = byParent[p];
    if (ids.length === 0) continue;

    if (ids.length === 1) {
      const orig = ids[0];
      const node = genResult.nodes[orig];
      nodeCluster[orig] = nextId;
      clusters.push({
        id:        nextId,
        centre:    [node.basePos[0], node.basePos[1], node.basePos[2]],
        spread:    0,
        count:     1,
        colour:    parent.clusters[p].colour,
        stability: NaN,
      });
      nextId++;
      continue;
    }

    // Build a sub-genResult that the algorithm can consume directly.
    // Local node ids are 0..ids.length-1; we map back to original ids
    // when writing into the global outputs.
    const subNodes = ids.map((origId, localIdx) => {
      const orig = genResult.nodes[origId];
      return { ...orig, id: localIdx };
    });
    const subResult = algo.infer({ ...genResult, nodes: subNodes }, params);

    for (let localIdx = 0; localIdx < ids.length; localIdx++) {
      const subCid = subResult.nodeCluster[localIdx];
      // subCid may be -1 for noise on noise-aware algos; map preserved.
      nodeCluster[ids[localIdx]] = subCid >= 0 ? nextId + subCid : -1;
    }
    for (const sc of subResult.clusters) {
      if (sc.id < 0) continue;   // noise pseudo-cluster (rare — re-emerge below)
      clusters.push({ ...sc, id: nextId + sc.id });
    }
    for (const e of subResult.structureEdges) {
      structureEdges.push([ids[e[0]], ids[e[1]]]);
    }
    nextId += subResult.clusters.length;
  }

  return {
    method: parent.method,
    params,
    clusters,
    nodeCluster,
    structureEdges,
  };
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
