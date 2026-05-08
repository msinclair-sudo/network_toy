// Citation-generation algorithm registry.
//
// Mirrors the clustering registry: one entry per algorithm, each
// exposing a standard interface that downstream layers consume
// without caring which algorithm produced the citation graph.
//
// Public contract validated by ./contract.js. Adding a new
// algorithm = one new entry here + the algorithm module; no other
// file should need to grow a switch on algorithm id.

import * as tasteNetwork from "./taste-network.js";

export const ALGORITHMS = [
  {
    id:           tasteNetwork.ID,
    label:        "Taste Network",
    description:  "Within-cluster mutual k-NN neighbourhoods feed a per-neighbourhood taste vector with shared-taste tilt; transitivity boosts triangle-completing pairs; final per-pair Bernoulli draws hit a user-set density budget split between intra- and cross-cluster categories.",
    defaultParams: tasteNetwork.defaultParams,
    infer:        tasteNetwork.infer,
    // modalSchema not yet driven from here — Phase 4 of v3 will
    // migrate the citation settings modal to be registry-rendered
    // (same pattern as the cluster modal in stage 5). For now the
    // hand-crafted modal in app/index.html is still the source of
    // truth for citation params.
    modalSchema:  [],
  },
];

const BY_ID = new Map(ALGORITHMS.map(a => [a.id, a]));

export function getAlgorithm(id) {
  const a = BY_ID.get(id);
  if (!a) throw new Error(`[CitationRegistry] unknown algorithm "${id}"`);
  return a;
}

export function listAlgorithms() {
  return ALGORITHMS.slice();
}
