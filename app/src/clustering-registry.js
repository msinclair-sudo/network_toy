// Clustering algorithm registry.
//
// Adding a new clustering algorithm = one entry here. The Cluster ▾
// dropdown, the cluster settings modal, and the recluster() pipeline all
// drive themselves from this list — no other file should need to grow a
// switch on algorithm id.
//
// Contract: every `infer` returned must satisfy the contract in
// doc/clustering.md §1, validated by contracts/cluster.js. The validator
// runs in main.js on every recluster() so contract violations surface
// immediately when adding a new algorithm.

import { inferClusters as inferMutualKNN } from "./clustering.js";

// Each entry's `infer` is called as infer(genResult, params) and must
// return a ClusterResult.
export const ALGORITHMS = [
  {
    id: "mutualKNN",
    label: "Mutual k-NN",
    description: "Each node connects to its top-K nearest neighbours; an edge counts only if the membership is mutual. Connected components become clusters.",
    allowsNoise: false,
    defaultParams: () => ({ mutualK: 5 }),
    infer: (genResult, params) => inferMutualKNN(genResult, params),
    modalSchema: [
      {
        key: "mutualK",
        label: "k",
        kind: "int",
        min: 1, max: 20, step: 1,
        format: (v) => String(v),
        hint: "Top-K nearest neighbours each node considers. Larger K → more pairs are mutual → fewer, bigger clusters.",
      },
    ],
  },
];

const BY_ID = new Map(ALGORITHMS.map(a => [a.id, a]));

export function getAlgorithm(id) {
  const a = BY_ID.get(id);
  if (!a) throw new Error(`[ClusterRegistry] unknown algorithm "${id}"`);
  return a;
}

export function listAlgorithms() {
  return ALGORITHMS.slice();
}
