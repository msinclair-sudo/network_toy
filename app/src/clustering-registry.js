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
import { inferHdbscan, defaultHdbscanParams } from "./clustering-hdbscan.js";

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
  {
    id: "hdbscan",
    label: "HDBSCAN",
    description: "Builds the mutual-reachability MST, walks its dendrogram condensed by min_cluster_size, scores each surviving cluster's stability, and selects the most stable subset (excess of mass). Cluster count is emergent. Points outside any stable cluster are noise; at stage 2 they are pooled into a single trailing 'noise' bucket.",
    allowsNoise: false,
    defaultParams: defaultHdbscanParams,
    infer: (genResult, params) => inferHdbscan(genResult, params),
    modalSchema: [
      {
        key: "minSamples",
        label: "min samples",
        kind: "int",
        min: 1, max: 30, step: 1,
        format: (v) => String(v),
        hint: "Defines core distance: each node's distance to its k-th nearest neighbour. Larger values = stronger smoothing and more aggressive density-awareness.",
      },
      {
        key: "minClusterSize",
        label: "min cluster size",
        kind: "int",
        min: 2, max: 50, step: 1,
        format: (v) => String(v),
        hint: "Smallest acceptable cluster size. Splits where one side falls below the threshold dissolve the smaller side into noise. Larger values → fewer, more substantial clusters.",
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
