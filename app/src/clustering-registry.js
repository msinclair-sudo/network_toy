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
    label: "HDBSCAN (stage 1)",
    description: "Builds the mutual-reachability MST under HDBSCAN's density-aware metric, then drops the K-1 longest edges to produce K clusters. Stage 1 placeholder — stage 2 will swap the fixed-K cut for the canonical condensed-tree + stability extraction.",
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
        key: "numClusters",
        label: "clusters",
        kind: "int",
        min: 1, max: 30, step: 1,
        format: (v) => String(v),
        hint: "Target number of clusters. Stage 1 cuts the MST's K-1 longest edges to produce this many components. Stage 2 will replace this with min_cluster_size and let the cluster count emerge.",
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
