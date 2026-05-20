// Clustering worker entry.
//
// One worker job = one full multi-level cluster cascade (either the
// post-fusion run or the pre-fusion run; never both — those are
// separate DAG nodes in recluster()).
//
// We don't run individual levels in separate workers: the levels are
// inherently sequential (each within-parent level reads the previous
// level's clusterResult), so per-level workers would serialise
// anyway. Sending one job per pass keeps postMessage traffic at one
// round-trip per pass.
//
// Protocol:
//   in:  { algoId, nodesSlim, dimredResult, levelCfgs, allowNoise, n }
//   out: { ok: true,  result: levels[] }
//        { ok: false, error: { message, name, stack? } }
//
// All algorithm modules + the registry are pure (no DOM, no esm.sh
// URLs in their import chain), so the worker can resolve `algoId` via
// the same registry the main thread uses.

import { getAlgorithm as getClusteringAlgorithm } from "../clustering-registry.js";
import { runClusterLevels }                        from "../clustering-cascade.js";

self.addEventListener("message", (ev) => {
  const { algoId, nodesSlim, dimredResult, levelCfgs, allowNoise, n } = ev.data || {};

  try {
    if (typeof algoId !== "string") {
      throw new Error("clustering-worker: payload.algoId must be a string");
    }
    if (!Array.isArray(nodesSlim)) {
      throw new Error("clustering-worker: payload.nodesSlim must be an array");
    }
    if (!Array.isArray(levelCfgs) || levelCfgs.length === 0) {
      throw new Error("clustering-worker: payload.levelCfgs must be a non-empty array");
    }
    const algo = getClusteringAlgorithm(algoId);
    const levels = runClusterLevels(algo, nodesSlim, levelCfgs, dimredResult, !!allowNoise, n | 0);

    // Transfer every nodeCluster Int32Array back so the main thread
    // can adopt them without copy. structureEdges arrays are small
    // JS arrays; clustering hot-path is the Int32Array.
    const transfer = [];
    for (const lvl of levels) {
      const buf = lvl.clusterResult.nodeCluster && lvl.clusterResult.nodeCluster.buffer;
      if (buf) transfer.push(buf);
    }
    self.postMessage({ ok: true, result: levels }, transfer);
  } catch (err) {
    self.postMessage({
      ok: false,
      error: { message: err.message, name: err.name, stack: err.stack },
    });
  }
});
