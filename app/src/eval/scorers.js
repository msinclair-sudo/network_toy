// Sweep scorers — pluggable evaluation metrics.
//
// A scorer is a (possibly async) function that takes a clustering
// outcome and returns:
//
//   { primary: number,    // higher = better; the rank key
//     secondary: number?,  // optional tie-breaker
//     numClusters: int,    // surfaced in the results table
//     extra?:    object,   // metric-specific detail (e.g. perCluster) }
//
// Two scorers today:
//   * ariScorer(groundTruth) — toy mode; ranks by Adjusted Rand Index
//     against the generator's originId.
//   * stabilityScorer(opts) — data-source-agnostic; runs bootstrap-
//     Jaccard and ranks by Hennig fraction-stable.
//
// The scorer signature is uniform so the sweep doesn't care which
// metric is active.

import { adjustedRandIndex } from "./ari.js";
import { bootstrapStability } from "./bootstrap.js";

// Toy-mode scorer. groundTruth is an Int32Array(n) of originId values.
// label reads as a compact noun phrase (used in status lines like
// "top 5 by match score") — the dropdown UI carries the longer
// descriptive labels.
export function ariScorer(groundTruth) {
  return {
    id:    "ari",
    label: "match score",
    isAsync: false,
    score(genResult, dimredResult, clusterResult, _algo, _params) {
      const ari = adjustedRandIndex(clusterResult.nodeCluster, groundTruth);
      return {
        primary:     Number.isFinite(ari) ? ari : -Infinity,
        secondary:   clusterResult.clusters.length,
        numClusters: clusterResult.clusters.length,
        extra:       null,
      };
    },
  };
}

// Real-data-friendly scorer. Runs B bootstrap iterations and ranks
// by `fractionStable` (Hennig). meanJaccard surfaces as the
// secondary tiebreaker.
//
// Failure mode (documented): coarse clusterings (1–3 clusters) score
// near-perfect because the bootstrap trivially reproduces them. The
// stability scorer alone over-rewards meaningless partitions. Use
// `clusterRichnessScorer` when count matters too.
export function stabilityScorer({ B = 10, subsampleFrac = 0.8, seed = 12345 } = {}) {
  return {
    id:    "stability",
    label: "reproducibility score",
    isAsync: true,
    async score(genResult, dimredResult, clusterResult, algo, params, ctx = {}) {
      const result = await bootstrapStability({
        refClusterResult: clusterResult,
        genResult,
        dimredResult,
        algo,
        params,
        B,
        subsampleFrac,
        seed,
        onProgress: ctx.onIterProgress || null,
        abortSignal: ctx.abortSignal     || null,
      });
      return {
        primary:     result.aggregate.fractionStable,
        secondary:   result.aggregate.meanJaccard,
        numClusters: result.aggregate.nClusters,
        extra:       result,
      };
    },
  };
}

// Counts-only scorer. Ranks by raw cluster count — informative when
// you trust the algorithm's geometry but want the resolution knob
// pushed toward "more clusters". Beware: noise-fragmented configs
// (e.g. 200 singletons) will dominate. Pair with a manual look at
// the rows or use `clusterRichnessScorer` for a balanced signal.
export function numClustersScorer() {
  return {
    id:    "numClusters",
    label: "cluster count",
    isAsync: false,
    score(genResult, dimredResult, clusterResult, _algo, _params) {
      const n = clusterResult.clusters.length;
      return {
        primary:     n,
        secondary:   0,
        numClusters: n,
        extra:       null,
      };
    },
  };
}

// Balanced scorer — cluster count weighted by bootstrap stability.
// Penalises both ends: a single mega-cluster scores 1 × 1.0 = 1; 100
// noise-fine clusters score 100 × 0.01 = 1; the sweet spot of e.g.
// 24 medium clusters at 0.55 mean Jaccard scores 24 × 0.55 = 13.2.
// This is the default scorer for real data when the user picks
// "Automatic".
export function clusterRichnessScorer({ B = 10, subsampleFrac = 0.8, seed = 12345 } = {}) {
  return {
    id:    "richness",
    label: "cluster richness",
    isAsync: true,
    async score(genResult, dimredResult, clusterResult, algo, params, ctx = {}) {
      const result = await bootstrapStability({
        refClusterResult: clusterResult,
        genResult,
        dimredResult,
        algo,
        params,
        B,
        subsampleFrac,
        seed,
        onProgress: ctx.onIterProgress || null,
        abortSignal: ctx.abortSignal     || null,
      });
      const nC      = result.aggregate.nClusters;
      const meanJ   = result.aggregate.meanJaccard;
      const richness = nC * meanJ;
      return {
        primary:     richness,
        secondary:   meanJ,
        numClusters: nC,
        extra:       result,
      };
    },
  };
}
