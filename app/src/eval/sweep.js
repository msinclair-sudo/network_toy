// Cross-algorithm parameter sweep.
//
// Enumerates configurations across (algorithms × per-algorithm
// modal-schema sweep grids), runs each one's clustering, and scores
// the result via a pluggable scorer (see eval/scorers.js). Returns a
// ranked list, top-N first.
//
// Async with progress + abort:
//   * onProgress(idx, total, label) fires after each config completes.
//   * abortSignal.aborted = true breaks out of the loop early; the
//     function resolves with whatever was scored so far.
//
// Yields between configs so the main thread repaints during a long
// sweep — and yields again inside the bootstrap (when the stability
// scorer is active) so the UI never freezes for more than ~1 config.

export async function sweepAcrossAlgorithms({
  algorithms,        // array of clustering registry entries
  genResult,
  dimredResult,
  scorer,            // from eval/scorers.js
  topN = 5,
  resolutionOnly = true,    // when true, only sweep fields tagged `resolution: true`
                            // — pin everything else to the algorithm's defaults.
                            // Keeps the search space tractable for cross-algo runs.
  onProgress = null,
  abortSignal = null,
}) {
  // Enumerate (algoId, params) configs. Each algorithm's axes come
  // from its modalSchema; when resolutionOnly is set we sweep only
  // the resolution-tagged fields (and pin the rest to defaults).
  const configs = [];
  for (const algo of algorithms) {
    const defaults = algo.defaultParams ? algo.defaultParams() : {};
    const axes = (algo.modalSchema || []).map(field => {
      const isRes = !!field.resolution;
      const shouldSweep = resolutionOnly ? isRes : true;
      if (shouldSweep && Array.isArray(field.sweepValues) && field.sweepValues.length > 0) {
        return { key: field.key, values: field.sweepValues };
      }
      if (shouldSweep && field.kind === "select") {
        return { key: field.key, values: (field.options || []).map(o => o.value) };
      }
      // Pin to default (or undefined if no default).
      return { key: field.key, values: [defaults[field.key]] };
    });
    for (const params of cartesian(axes)) {
      configs.push({ algo, params });
    }
  }

  const total = configs.length;
  const results = [];

  for (let i = 0; i < total; i++) {
    if (abortSignal && abortSignal.aborted) break;
    const { algo, params } = configs[i];
    const label = `${algo.id} ${formatParams(params)}`;

    let scored = null;
    try {
      const cr = algo.infer(genResult, params, dimredResult);
      const ctx = { abortSignal, onIterProgress: null };   // bootstrap loop yields internally
      const s  = scorer.isAsync
        ? await scorer.score(genResult, dimredResult, cr, algo, params, ctx)
        : scorer.score(genResult, dimredResult, cr, algo, params);
      scored = {
        algoId:      algo.id,
        algoLabel:   algo.label || algo.id,
        params,
        primary:     s.primary,
        secondary:   s.secondary,
        numClusters: s.numClusters,
        extra:       s.extra,
      };
    } catch (e) {
      console.error(`[sweep] config ${i+1}/${total} (${label}) threw:`, e);
      scored = {
        algoId:      algo.id,
        algoLabel:   algo.label || algo.id,
        params,
        primary:     -Infinity,
        secondary:   0,
        numClusters: 0,
        error:       String(e.message || e),
      };
    }
    results.push(scored);
    if (onProgress) onProgress(i + 1, total, label);

    // Yield so the main thread can repaint between configs even when
    // the active scorer is synchronous (ARI).
    await new Promise(r => setTimeout(r, 0));
  }

  results.sort((a, b) => {
    const ap = Number.isFinite(a.primary) ? a.primary : -Infinity;
    const bp = Number.isFinite(b.primary) ? b.primary : -Infinity;
    if (bp !== ap) return bp - ap;
    const as = +a.secondary || 0;
    const bs = +b.secondary || 0;
    return bs - as;
  });

  return {
    ranked:        results,
    top:           results.slice(0, topN),
    totalConfigs:  total,
    completed:     results.length,
  };
}

function cartesian(axes) {
  if (axes.length === 0) return [{}];
  const out = [];
  const acc = {};
  const recurse = (idx) => {
    if (idx === axes.length) { out.push({ ...acc }); return; }
    const ax = axes[idx];
    for (const v of ax.values) {
      acc[ax.key] = v;
      recurse(idx + 1);
    }
  };
  recurse(0);
  return out;
}

function formatParams(params) {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${formatVal(v)}`)
    .join(" ");
}

function formatVal(v) {
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return String(v);
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  return String(v);
}

// ── Legacy wrapper ──────────────────────────────────────────────────
// Pre-existing main.js (legacy shell) calls sweepAlgorithm with a
// synchronous ARI signature. Keep it working.
import { adjustedRandIndex } from "./ari.js";

export function sweepAlgorithm(algo, genResult, dimredResult, groundTruth, pendingParams, topN = 5) {
  // Some legacy call sites pass groundTruth in slot 3 (no dimredResult).
  // Detect and shuffle.
  let g = genResult, dr = dimredResult, gt = groundTruth, pp = pendingParams, n = topN;
  if (groundTruth instanceof Int32Array && !(dimredResult && dimredResult.data instanceof Float32Array)) {
    // Old 4-arg signature: (algo, genResult, groundTruth, params, topN)
    g  = genResult;
    dr = undefined;
    gt = dimredResult;   // was 'groundTruth' in old slot
    pp = groundTruth;    // was 'pendingParams' in old slot
    n  = pendingParams !== undefined ? pendingParams : 5;
  }
  const axes = (algo.modalSchema || []).map(field => {
    if (Array.isArray(field.sweepValues) && field.sweepValues.length > 0) {
      return { key: field.key, values: field.sweepValues };
    }
    if (field.kind === "select") {
      return { key: field.key, values: (field.options || []).map(o => o.value) };
    }
    return { key: field.key, values: [pp ? pp[field.key] : undefined] };
  });
  const combos = cartesian(axes);
  const results = [];
  for (const params of combos) {
    let r;
    try { r = algo.infer(g, params, dr); }
    catch (e) {
      results.push({ params, ari: NaN, numClusters: 0, error: String(e.message || e) });
      continue;
    }
    const ari = adjustedRandIndex(r.nodeCluster, gt);
    results.push({ params, ari, numClusters: r.clusters.length });
  }
  results.sort((a, b) => {
    const ap = Number.isFinite(a.ari) ? a.ari : -Infinity;
    const bp = Number.isFinite(b.ari) ? b.ari : -Infinity;
    return bp - ap;
  });
  return { top: results.slice(0, n), totalCombos: combos.length };
}
