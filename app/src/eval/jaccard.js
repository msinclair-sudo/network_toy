// Jaccard similarity helpers.
//
// jaccardSimilarity(A, B) = |A ∩ B| / |A ∪ B|, range [0, 1].
// Sets passed in as Set or Array (we treat any iterable of node ids).
//
// bestMatchJaccard(refLabels, candLabels, idMask?) computes, for each
// label in `refLabels`, the maximum Jaccard against any label in
// `candLabels`. Returns a Map<refLabel, {bestCandLabel, jaccard}>.
// `idMask` (optional) restricts the comparison to a subset of node
// ids — used by the bootstrap so the reference cluster's "members"
// are the ones that survived subsampling, not all members.

export function jaccardSimilarity(setA, setB) {
  const A = setA instanceof Set ? setA : new Set(setA);
  const B = setB instanceof Set ? setB : new Set(setB);
  if (A.size === 0 && B.size === 0) return 1;   // convention: both-empty match
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const uni = A.size + B.size - inter;
  return uni === 0 ? 0 : inter / uni;
}

// Inputs:
//   refLabels  — Int32Array(n), label per node in reference clustering
//   candLabels — Int32Array(n), label per node in candidate clustering
//                (-1 entries = noise / excluded; ignored both ways)
//   idMask     — Set<int> | null, restrict analysis to these node ids
//                (intersection: only ids in mask AND with valid ref/cand
//                labels participate). Pass null to include every node.
//
// Returns Map<refLabel, {bestCandLabel, jaccard}>.
export function bestMatchJaccard(refLabels, candLabels, idMask = null) {
  if (refLabels.length !== candLabels.length) {
    throw new Error("[jaccard] refLabels.length must equal candLabels.length");
  }
  const n = refLabels.length;

  // Build {refLabel → Set of node ids} and {candLabel → Set of node ids}
  // restricted to the mask.
  const refGroups  = new Map();
  const candGroups = new Map();
  for (let i = 0; i < n; i++) {
    if (idMask && !idMask.has(i)) continue;
    const r = refLabels[i];
    const c = candLabels[i];
    if (r >= 0) {
      if (!refGroups.has(r)) refGroups.set(r, new Set());
      refGroups.get(r).add(i);
    }
    if (c >= 0) {
      if (!candGroups.has(c)) candGroups.set(c, new Set());
      candGroups.get(c).add(i);
    }
  }

  const out = new Map();
  for (const [refLabel, refSet] of refGroups) {
    let bestJ = 0;
    let bestC = -1;
    for (const [candLabel, candSet] of candGroups) {
      const j = jaccardSimilarity(refSet, candSet);
      if (j > bestJ) { bestJ = j; bestC = candLabel; }
    }
    out.set(refLabel, { bestCandLabel: bestC, jaccard: bestJ });
  }
  return out;
}
