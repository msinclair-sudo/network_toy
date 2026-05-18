// Bootstrap-Jaccard cluster stability (Hennig 2007).
//
// Idea: a real cluster reappears in clusterings of slightly-different
// data. An artifact falls apart. So:
//   1. Take the reference clustering as ground truth.
//   2. Repeat B times: subsample the data, re-cluster from scratch.
//   3. For each reference cluster, compute its max-Jaccard against
//      any cluster in the bootstrap (restricted to subsample members).
//   4. Mean the max-Jaccards across B iters → stability score.
//   5. Hennig thresholds: ≥0.85 stable, 0.6–0.85 doubtful, <0.6 not.
//
// Async + cooperative — yields between iterations so the main thread
// repaints. onProgress(iter, total) fires after each bootstrap completes
// and is the user's progress signal. Pass abortSignal.aborted=true to
// stop early; the function resolves with whatever it has.
//
// Multi-level handling: validates the FINEST level only. For multi-
// level clusterings each bootstrap re-runs the same algorithm (single-
// level) on the subsampled finest-level positions. Within-parent scope
// isn't exercised in v1 — the bootstrap reclusters the whole subsample
// in one pass. Acceptable for now since the smoke flow uses the
// default single-level config.

import { mulberry32 } from "../rng.js";
import { bestMatchJaccard } from "./jaccard.js";

export const HENNIG_STABLE   = 0.85;
export const HENNIG_DOUBTFUL = 0.60;

// Classify a Jaccard score per Hennig 2007.
export function classifyJaccard(j) {
  if (j >= HENNIG_STABLE)   return "stable";
  if (j >= HENNIG_DOUBTFUL) return "doubtful";
  return "unstable";
}

// Inputs:
//   refClusterResult — {nodeCluster, clusters, ...} the reference partition
//   genResult        — Layer 1 result (used to slice sub-genResult per iter)
//   dimredResult     — Layer 1.5 result (sliced parallel to genResult)
//   algo             — clustering registry entry
//   params           — params for that algorithm
//   B                — number of bootstrap iterations (default 25)
//   subsampleFrac    — fraction of nodes to keep per iter (default 0.8)
//   seed             — base RNG seed for sample indices
//   onProgress       — callback(iter, total) after each iter
//   abortSignal      — {aborted: bool}; loop checks before each iter
//
// Returns Promise<{
//   perCluster: [{clusterId, memberCount, meanJaccard, classification}],
//   aggregate:  {nClusters, nStable, nDoubtful, nUnstable, fractionStable, meanJaccard},
//   bootstrapsRun: int,
// }>.
export async function bootstrapStability({
  refClusterResult,
  genResult,
  dimredResult,
  algo,
  params,
  B = 25,
  subsampleFrac = 0.8,
  seed = 12345,
  onProgress = null,
  abortSignal = null,
}) {
  const n = refClusterResult.nodeCluster.length;
  const refLabels = refClusterResult.nodeCluster;
  const refClusterIds = refClusterResult.clusters.map(c => c.id).filter(id => id >= 0);

  // Per-cluster running tally of max-Jaccards across iters.
  const sumJ   = new Map();
  const countJ = new Map();
  for (const id of refClusterIds) { sumJ.set(id, 0); countJ.set(id, 0); }

  const rng = mulberry32(seed >>> 0);
  let iters = 0;

  for (let it = 0; it < B; it++) {
    if (abortSignal && abortSignal.aborted) break;

    // Sample roughly subsampleFrac × n distinct node ids without replacement.
    const subSet = sampleSubset(n, subsampleFrac, rng);
    const subIds = Array.from(subSet).sort((a, b) => a - b);
    const k = subIds.length;
    if (k < 2) continue;

    // Build sub-genResult (id-renumbered to 0..k-1) and sub-dimredResult.
    const subGen     = sliceGenResult(genResult, subIds);
    const subDimred  = sliceDimredResult(dimredResult, subIds);

    // Run the algorithm on the subsample.
    let candResult;
    try {
      candResult = algo.infer(subGen, params, subDimred);
    } catch (e) {
      console.error("[bootstrap] algo.infer threw on iter", it, e);
      continue;
    }

    // candResult.nodeCluster is keyed by SUB ids (0..k-1). Map back to
    // original ids by lifting to a full-size labels array filled with -1.
    const candLabelsFull = new Int32Array(n).fill(-1);
    for (let li = 0; li < k; li++) {
      candLabelsFull[subIds[li]] = candResult.nodeCluster[li];
    }

    // Score: for each ref cluster, max Jaccard vs any cand cluster,
    // restricted to the subsample (so reference members not in this
    // subsample don't penalise the score).
    const matches = bestMatchJaccard(refLabels, candLabelsFull, subSet);
    for (const id of refClusterIds) {
      const m = matches.get(id);
      const j = m ? m.jaccard : 0;
      sumJ.set(id, sumJ.get(id) + j);
      countJ.set(id, countJ.get(id) + 1);
    }
    iters++;

    if (onProgress) onProgress(iters, B);

    // Yield to the event loop so the UI repaints between iterations.
    await new Promise(r => setTimeout(r, 0));
  }

  // Build perCluster output, including reference clusters not seen in
  // any iter (treat their score as 0).
  const memberCount = new Map();
  for (let i = 0; i < n; i++) {
    const id = refLabels[i];
    if (id < 0) continue;
    memberCount.set(id, (memberCount.get(id) || 0) + 1);
  }
  const perCluster = refClusterIds.map(id => {
    const cnt = countJ.get(id) || 0;
    const meanJ = cnt > 0 ? sumJ.get(id) / cnt : 0;
    return {
      clusterId:      id,
      memberCount:    memberCount.get(id) || 0,
      meanJaccard:    meanJ,
      classification: classifyJaccard(meanJ),
    };
  });

  // Aggregate across clusters. Mean Jaccard weighted by member count.
  let nStable = 0, nDoubtful = 0, nUnstable = 0;
  let weightedSum = 0, weightTotal = 0;
  for (const p of perCluster) {
    if (p.classification === "stable")   nStable++;
    if (p.classification === "doubtful") nDoubtful++;
    if (p.classification === "unstable") nUnstable++;
    weightedSum += p.meanJaccard * p.memberCount;
    weightTotal += p.memberCount;
  }
  const aggregate = {
    nClusters:      perCluster.length,
    nStable, nDoubtful, nUnstable,
    fractionStable: perCluster.length > 0 ? nStable / perCluster.length : 0,
    meanJaccard:    weightTotal > 0 ? weightedSum / weightTotal : 0,
  };

  return { perCluster, aggregate, bootstrapsRun: iters };
}

// Pick approximately frac × n distinct ids in [0, n).
function sampleSubset(n, frac, rng) {
  const target = Math.max(2, Math.min(n, Math.round(n * frac)));
  const out = new Set();
  while (out.size < target) {
    out.add(Math.floor(rng() * n));
  }
  return out;
}

function sliceGenResult(genResult, subIds) {
  const subNodes = subIds.map((origId, localIdx) => {
    const orig = genResult.nodes[origId];
    return { ...orig, id: localIdx };
  });
  return { ...genResult, nodes: subNodes };
}

function sliceDimredResult(dimredResult, subIds) {
  const d  = dimredResult.d;
  const src = dimredResult.data;
  const out = new Float32Array(subIds.length * d);
  for (let li = 0; li < subIds.length; li++) {
    const oi = subIds[li];
    for (let k = 0; k < d; k++) out[li * d + k] = src[oi * d + k];
  }
  return {
    method: dimredResult.method,
    params: dimredResult.params,
    n:      subIds.length,
    d,
    data:   out,
  };
}
