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
        sweepValues: [2, 3, 4, 5, 7, 10, 15, 20],
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
        sweepValues: [1, 3, 5, 8, 12, 20],
      },
      {
        key: "minClusterSize",
        label: "min cluster size",
        kind: "int",
        min: 2, max: 50, step: 1,
        format: (v) => String(v),
        hint: "Smallest acceptable cluster size. Splits where one side falls below the threshold dissolve the smaller side into noise. Larger values → fewer, more substantial clusters.",
        sweepValues: [2, 3, 5, 8, 12, 20],
      },
      {
        key: "selectionMethod",
        label: "selection",
        kind: "select",
        options: [
          { value: "eom",  label: "EOM (excess of mass)" },
          { value: "leaf", label: "Leaf (every condensed-tree leaf)" },
        ],
        hint: "EOM: classic — picks the most stable cluster frontier. Can collapse to ~2 clusters when blobs overlap because the dendrogram becomes a long imbalanced chain (one giant cluster nibbling small pieces). Leaf: picks every condensed-tree leaf instead — finer-grained and immune to that bifurcation, but produces lots of tiny clusters. Pair with selection epsilon to roll fine leaves up to a coarser scale.",
      },
      {
        key: "selectionEpsilon",
        label: "selection ε",
        kind: "range",
        min: 0, max: 80, step: 1,
        format: (v) => (+v).toFixed(0),
        hint: "Distance threshold (same scale as basePos distances). After EOM/leaf selection, any cluster born at a finer density level (birth distance < ε) is merged into its first ancestor whose birth distance is ≥ ε. 0 disables. Most useful with leaf mode to control granularity smoothly between 'every leaf' and 'big clusters only'.",
        sweepValues: [0, 5, 10, 15, 20, 25, 30, 40, 60],
      },
      {
        key: "noiseMode",
        label: "noise mode",
        kind: "select",
        options: [
          { value: "absorb",     label: "Soft absorb (sklearn approximate_predict)" },
          { value: "singletons", label: "Singletons (each noise point its own cluster)" },
        ],
        hint: "What to do with noise points (those EOM left outside any stable cluster). Absorb folds them into the most likely stable cluster, weighted by mutual reachability and cluster stability. Singletons keeps each noise point as its own cluster. Either way, debug overlays can flag pre-absorption noise via Debug ▾ → noise rings.",
        // Pin during sweeps: singletons inflates cluster count but doesn't
        // change the algorithm's structural decision. ARI would always be
        // worse than the matching absorb run, so sweeping it is wasted work.
        sweepValues: ["absorb"],
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
