// Citation layout algorithm registry.
//
// One entry per algorithm, same pattern as clustering-registry and
// citations/registry. The blend module (Phase 3) consumes this
// registry to produce alignedCitationPos for the α=1 endpoint of the
// blend.
//
// Adding a new algorithm = one new entry here + the algorithm
// module. No other file should grow a switch on algorithm id.

import * as fr  from "./fr.js";
import * as mds from "./mds.js";

export const ALGORITHMS = [
  {
    id:           fr.ID,
    label:        "Fruchterman–Reingold (3D)",
    description:  "Force-directed cladogram-flavoured layout: every pair repels, citation edges attract, plus a time-axis radial anchor that draws older nodes toward the centre. Encodes which nodes are connected; edge LENGTHS are arbitrary (set by FR's force balance, not by graph distance). Unrooted — no privileged axis.",
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
  {
    id:           mds.ID,
    label:        "MDS (graph-distance preserving)",
    description:  "Dendrogram-flavoured layout: per-pair distance in 3D matches graph-shortest-path distance (in graph hops). A 1–2–3 chain ends up collinear with |x_1 − x_3| = 2·|x_1 − x_2|, exactly because graph distance d(1,3)=2. Per-component (each connected component is a separate MDS problem); cross-component pairs are deliberately omitted from the stress function — there's no path so there's no graph distance to preserve. Alignment in blend/align.js handles cross-component placement via basePos.",
    defaultParams: mds.defaultParams,
    compute:      mds.compute,
    modalSchema:  [
      {
        key:   "iterations",
        label: "iterations",
        kind:  "int",
        min:   50, max: 600, step: 10,
        format: (v) => String(v),
        hint:  "Spring-relaxation iterations on the stress function. 200 converges well for components ≤ a few hundred nodes.",
      },
      {
        key:   "scaleD",
        label: "scale per hop",
        kind:  "range",
        min:   1, max: 30, step: 0.5,
        format: (v) => (+v).toFixed(1),
        hint:  "World units per graph hop, i.e. target distance for adjacent nodes. Per-component alignment scales the final layout to match basePos extent, so this only affects the intermediate density — the final visible scale is the same.",
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
