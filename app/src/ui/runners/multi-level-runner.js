// Multi-level clustering runner (MLC §9 / §4).
//
// Wraps engine.recomputeMultiLevel — ONE HDBSCAN run whose condensed
// tree is cut into a coarse→fine ladder of partitions (with bridge-
// producing absorption). Like the other analysis runners it's a
// queue-job factory; the descriptor (layer-descriptors.js) creates the
// `multiLevel` card under the selected dimred ancestor and enqueues this.
//
// The lane mutates the legacy state slots (state.clusterLevels etc.) so
// the viewer updates live; we then snapshot those into the card result so
// the projection layer can replay them when the card is re-selected.

import { getState } from "../state.js";
import * as engine  from "../engine.js";

const SCORE_VERSION = 1;

/**
 * @param {object} opts
 * @param {{minSamples:number, minClusterSize:number}} opts.params  HDBSCAN params.
 * @param {number} opts.capLayers     hard cap on discovered layers (≤ 5).
 * @param {number} [opts.minClusters] minimum clusters for a layer to count.
 * @param {string} opts.uidPrefix     unique per-card prefix for level uids.
 * @returns {(ctx:{signal,setPhase,setProgress}) => Promise<object>}
 */
export function buildMultiLevelJob({ params, capLayers, minClusters, uidPrefix }) {
  return async function runMultiLevelJob(ctx) {
    ctx.setPhase    && ctx.setPhase("HDBSCAN → layers");
    ctx.setProgress && ctx.setProgress(0.1);

    const out = await engine.recomputeMultiLevel({
      params, capLayers, minClusters, uidPrefix,
    });

    if (!out.levels || out.levels.length === 0) {
      throw new Error(
        "Multi-level extraction found no stable layers — try a smaller " +
        "minClusterSize, or a dim-reduction that exposes more structure.");
    }
    ctx.setProgress && ctx.setProgress(1);

    const s = getState();
    return {
      capturedAt:     new Date().toISOString(),
      clusterLevels:  s.clusterLevels,
      clusterResult:  s.clusterResult,
      bridgeAnalysis: s.bridgeAnalysis,
      layers:         out.layers,
      settings:       { ...params, capLayers },
      nLevels:        out.levels.length,
      scoreVersion:   SCORE_VERSION,
    };
  };
}
