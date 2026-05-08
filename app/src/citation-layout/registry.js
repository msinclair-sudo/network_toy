// Citation layout algorithm registry.
//
// One entry per algorithm, same pattern as clustering-registry and
// citations/registry. The blend module (Phase 3) consumes this
// registry to produce alignedCitationPos for the α=1 endpoint of the
// blend.
//
// Adding a new algorithm = one new entry here + the algorithm
// module. No other file should grow a switch on algorithm id.

import * as fr from "./fr.js";

export const ALGORITHMS = [
  {
    id:           fr.ID,
    label:        "Fruchterman–Reingold (3D)",
    description:  "Force-directed layout: every pair repels, citation edges attract, plus a time-axis radial anchor that draws older nodes toward the centre. Unrooted — no privileged axis. Deterministic with a seed derived from the citation seed.",
    defaultParams: fr.defaultParams,
    compute:      fr.compute,
    modalSchema:  [
      {
        key:   "iterations",
        label: "iterations",
        kind:  "int",
        min:   50, max: 600, step: 10,
        format: (v) => String(v),
        hint:  "More iterations = better convergence, slower recompute. 200 is fine for n ≤ 500.",
      },
      {
        key:   "tBias",
        label: "time bias",
        kind:  "range",
        min:   0, max: 1.5, step: 0.05,
        format: (v) => (+v).toFixed(2),
        hint:  "Strength of the radial anchor that pulls older nodes (low t) toward origin. 0 = no time bias, 1 = strong centring of the oldest paper. Floor of 0.2 always applies so newest nodes can't escape under pure repulsion.",
      },
    ],
  },
];

const BY_ID = new Map(ALGORITHMS.map(a => [a.id, a]));

export function getAlgorithm(id) {
  const a = BY_ID.get(id);
  if (!a) throw new Error(`[CitationLayoutRegistry] unknown algorithm "${id}"`);
  return a;
}

export function listAlgorithms() {
  return ALGORITHMS.slice();
}
