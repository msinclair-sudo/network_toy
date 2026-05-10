// Bridge analysis — pure derivation on top of multi-level clustering.
//
// A FINE cluster (at level i+1) is a "bridge" iff its members come
// from two or more COARSE clusters (at level i). The analysis pairs
// the FINEST level against the level immediately above it; if there
// are more than two levels we'd run separate analyses for each pair,
// but for now the toy surfaces only the deepest pair (most useful
// research question).
//
// Returns null when fewer than two levels exist (no parent to bridge).
//
// Output shape:
//
//   {
//     coarseLevel: int,
//     fineLevel:   int,
//     perCluster: [{
//       fineId, memberCount, spanCount, dominantCoarseId,
//       dominantFraction, isBridge,
//       coarseShares: [{id, count, fraction}]   sorted desc by count
//     }],
//     perNodeScore:    Float32Array(n),    boundary score [0, 1] per node
//                                           = 1 - dominantFraction of node's
//                                           fine cluster
//     perNodeIsBridge: Uint8Array(n),      1 if owning fine cluster spans ≥2
//     bridgeCount: int,                    convenience tally
//   }
//
// "boundary score" definition: `1 − dominantFraction`. Interior
// clusters (one parent) get 0; perfectly even mixing → close to 1.
// Captures graded mixing without the entropy formula's interpretive
// quirks. Per-node value is the same for every member of the same
// fine cluster (bridge-ness is a cluster property, not a node
// property).

export function computeBridgeAnalysis(clusterLevels) {
  if (!clusterLevels || clusterLevels.length < 2) return null;

  const fineLevelIdx   = clusterLevels.length - 1;
  const coarseLevelIdx = fineLevelIdx - 1;
  const fine   = clusterLevels[fineLevelIdx].clusterResult;
  const coarse = clusterLevels[coarseLevelIdx].clusterResult;
  const n      = fine.nodeCluster.length;

  // Group node ids by fine cluster id.
  const byFine = new Map();
  for (let i = 0; i < n; i++) {
    const fid = fine.nodeCluster[i];
    if (fid < 0) continue;
    if (!byFine.has(fid)) byFine.set(fid, []);
    byFine.get(fid).push(i);
  }

  const perCluster = [];
  const byFineId   = new Map();
  for (const fineCluster of fine.clusters) {
    const members = byFine.get(fineCluster.id) || [];

    // Coarse-membership histogram.
    const counts = new Map();
    for (const nid of members) {
      const cid = coarse.nodeCluster[nid];
      counts.set(cid, (counts.get(cid) || 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const total  = members.length || 1;
    const shares = sorted.map(([id, count]) => ({
      id, count, fraction: count / total,
    }));

    const dominantCoarseId = shares.length > 0 ? shares[0].id       : -1;
    const dominantFraction = shares.length > 0 ? shares[0].fraction : 0;
    const spanCount        = shares.length;
    const isBridge         = spanCount >= 2;

    const entry = {
      fineId:           fineCluster.id,
      memberCount:      members.length,
      spanCount,
      dominantCoarseId,
      dominantFraction,
      coarseShares:     shares,
      isBridge,
    };
    perCluster.push(entry);
    byFineId.set(fineCluster.id, entry);
  }

  // Per-node arrays: each node inherits its fine cluster's bridge
  // properties.
  const perNodeScore    = new Float32Array(n);
  const perNodeIsBridge = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const fid = fine.nodeCluster[i];
    const info = fid >= 0 ? byFineId.get(fid) : null;
    if (info) {
      perNodeScore[i]    = 1 - info.dominantFraction;
      perNodeIsBridge[i] = info.isBridge ? 1 : 0;
    }
  }

  const bridgeCount = perCluster.reduce((acc, p) => acc + (p.isBridge ? 1 : 0), 0);

  return {
    coarseLevel:    coarseLevelIdx,
    fineLevel:      fineLevelIdx,
    perCluster,
    perNodeScore,
    perNodeIsBridge,
    bridgeCount,
  };
}
