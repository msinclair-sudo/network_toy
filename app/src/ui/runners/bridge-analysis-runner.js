// Bridge-analysis runner — first of the "analysis layer" cards.
//
// Wraps the pure computeBridgeAnalysis() derivation as a queue-job-shaped
// function bound to a workflow step. Like the other analysis runners it:
//   - reads its clustering from the parent card's snapshot (immutable per
//     §10.D1), NOT from live state, so re-selecting another card mid-flight
//     can't pull the rug out;
//   - returns a result the bridge-analysis panel renders (the projection
//     layer replays result.bridgeAnalysis into state.bridgeAnalysis when
//     the card is selected, so the existing singleton panel needs no
//     changes).
//
// The derivation is cheap (O(n) over the fine level's members) — there's
// no worker; we just await a microtask so the spinner shows for slow
// upstreams. A parent with <2 levels has no fine/coarse pair to compare,
// so we fail fast with a clear message.

import { getStep }              from "../workflow.js";
import { computeBridgeAnalysis } from "../bridge-analysis.js";

/**
 * @param {object} opts
 * @param {string} opts.parentStepId           Clustering-like card id.
 * @param {{fineLevel?:number, coarseLevel?:number}} opts.params
 * @returns {(ctx:{signal,setPhase,setProgress}) => Promise<object>}
 */
export function buildBridgeAnalysisJob({ parentStepId, params }) {
  return async function runBridgeAnalysisJob(ctx) {
    const parent = getStep(parentStepId);
    if (!parent) {
      throw new Error(`[bridge-analysis-runner] parent step "${parentStepId}" no longer exists`);
    }
    const snap   = parent.result || {};
    const levels = snap.clusterLevels || [];
    if (levels.length < 2) {
      throw new Error(
        "Bridge analysis needs at least two clustering levels — run it on a " +
        "multi-layer card (or a multi-level clustering), not a single partition.");
    }

    ctx.setPhase    && ctx.setPhase("fine → coarse shares");
    ctx.setProgress && ctx.setProgress(0.2);

    const ba = computeBridgeAnalysis(levels, {
      fineLevel:   params && params.fineLevel,
      coarseLevel: params && params.coarseLevel,
    });
    ctx.setProgress && ctx.setProgress(1);

    return {
      capturedAt:    new Date().toISOString(),
      bridgeAnalysis: ba,
      // Echo the resolved pair (computeBridgeAnalysis clamps invalid input)
      // so the projection layer can restore state.bridgeConfig too.
      params:        { fineLevel: ba.fineLevel, coarseLevel: ba.coarseLevel },
      nBridges:      ba.bridgeCount,
      nLevels:       levels.length,
    };
  };
}
