// Generic grid sweep over a clustering algorithm's modal-schema
// fields. Each field declares its sweep grid via `sweepValues`; if
// omitted, the field is pinned to the user's current pending value
// during the sweep (so the user can freeze axes by leaving them off).
// Select fields default to sweeping every option.
//
// Returns an array sorted descending by ARI:
//   [{ params, ari, numClusters }, ...]
//
// No DOM, no app state. Caller passes algo + genResult + ground-truth
// + current pending params.

import { adjustedRandIndex } from "./ari.js";

export function sweepAlgorithm(algo, genResult, groundTruth, pendingParams, topN = 5) {
  const axes = algo.modalSchema.map((field) => {
    if (Array.isArray(field.sweepValues) && field.sweepValues.length > 0) {
      return { key: field.key, values: field.sweepValues };
    }
    if (field.kind === "select") {
      return { key: field.key, values: field.options.map((o) => o.value) };
    }
    return { key: field.key, values: [pendingParams[field.key]] };
  });

  const combos = cartesian(axes);
  const results = new Array(combos.length);
  for (let i = 0; i < combos.length; i++) {
    const params = combos[i];
    let r;
    try {
      r = algo.infer(genResult, params);
    } catch (e) {
      results[i] = { params, ari: NaN, numClusters: 0, error: String(e.message || e) };
      continue;
    }
    const ari = adjustedRandIndex(r.nodeCluster, groundTruth);
    results[i] = { params, ari, numClusters: r.clusters.length };
  }

  results.sort((a, b) => {
    const aAri = Number.isFinite(a.ari) ? a.ari : -Infinity;
    const bAri = Number.isFinite(b.ari) ? b.ari : -Infinity;
    return bAri - aAri;
  });
  return { top: results.slice(0, topN), totalCombos: combos.length };
}

function cartesian(axes) {
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
