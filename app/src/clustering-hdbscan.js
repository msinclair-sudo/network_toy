// Clustering layer — HDBSCAN, Stage 1 (core distance + MST + fixed-K cut).
//
// Stage 1 is a stepping stone, not the final algorithm:
//   - Core distances + mutual reachability + MST: implemented properly.
//   - Cluster extraction: a placeholder that drops the K-1 longest MST
//     edges to produce K components. Stage 2 replaces this with the
//     canonical condensed-tree + EOM stability extraction.
//
// Math reference: doc/clustering.md §4.2 (and Stage 1 footnote).
// Output contract: doc/clustering.md §1, validated by contracts/cluster.js.
//
// Reads basePos only. Does NOT mutate the input. Always satisfies the
// shared cluster-output contract — the caller can swap this with
// mutual-k-NN with no other code changes.
//
// At Stage 1 there is no noise concept yet — every node lands in exactly
// one of the K clusters. allowsNoise will flip true at Stage 3.

const TABLEAU10 = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ab",
];

export const defaultHdbscanParams = () => ({
  minSamples: 5,
  numClusters: 7,    // placeholder — Stage 2 replaces this with min_cluster_size
});

export function inferHdbscan(genResult, params = {}) {
  const nodes = genResult.nodes;
  const n = nodes.length;
  const minSamples  = Math.max(1, Math.min(Math.max(1, n - 1), (params.minSamples ?? 5) | 0));
  const numClusters = Math.max(1, Math.min(Math.max(1, n), (params.numClusters ?? 7) | 0));

  if (n === 0) {
    return {
      method: "hdbscan",
      params: { minSamples, numClusters },
      clusters: [],
      nodeCluster: new Int32Array(0),
      structureEdges: [],
    };
  }
  if (n === 1) {
    return {
      method: "hdbscan",
      params: { minSamples, numClusters },
      clusters: [trivialCluster(0, nodes[0].basePos, 0, 1)],
      nodeCluster: new Int32Array([0]),
      structureEdges: [],
    };
  }

  // 1. Pairwise Euclidean distance matrix on basePos. We need the full
  //    matrix for both core distances and mutual reachability — cheap at
  //    our scale, and reusable across Stage 2.
  const dist = pairwiseDistances(nodes, n);

  // 2. Core distance per node: distance to the k_min-th nearest other node.
  //    With minSamples=k, we want the (k-1)-th element of the sorted-other
  //    distances (zero-indexed), since "the k-th nearest neighbour"
  //    excludes the point itself.
  const coreDist = computeCoreDistances(dist, n, minSamples);

  // 3. Mutual reachability d_mreach(i,j) = max(coreDist(i), coreDist(j), dist(i,j))
  //    is computed lazily inside Prim's so we don't materialise an n×n
  //    inflated matrix.

  // 4. Prim's MST under d_mreach. Returns n-1 edges, ascending weight order.
  const mstEdges = primMSTMutualReach(dist, coreDist, n);

  // 5. Stage 1 extraction: drop the (K-1) longest MST edges to leave K
  //    components. Sort edges by weight descending, drop the top
  //    (numClusters - 1), keep the rest.
  const sortedDesc = mstEdges.slice().sort((a, b) => b.w - a.w);
  const dropped = sortedDesc.slice(0, Math.max(0, numClusters - 1));
  const droppedSet = new Set(dropped.map(e => edgeKey(e.i, e.j)));
  const keptEdges = mstEdges.filter(e => !droppedSet.has(edgeKey(e.i, e.j)));

  // Debug overlay: the kept MST edges. The full MST is the structural
  // backbone HDBSCAN reasoned over; the kept edges show the within-cluster
  // backbone for the chosen K. (Stage 2 will switch this back to the full
  // MST since by then "K" is no longer a slider.)
  const structureEdges = keptEdges.map(e => [Math.min(e.i, e.j), Math.max(e.i, e.j)]);

  // 6. Connected components via union-find on the kept edges.
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  for (const e of keptEdges) union(e.i, e.j);

  // 7. Compress roots → contiguous cluster labels [0..numComponents).
  //    numComponents may be less than the requested numClusters if the
  //    user asked for more clusters than the MST has edges (n=1, or
  //    pathological cases). We trust the actual count.
  const roots = new Map();
  let numComponents = 0;
  const nodeCluster = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!roots.has(r)) roots.set(r, numComponents++);
    nodeCluster[i] = roots.get(r);
  }

  // 8. Per-cluster centroid + RMS spread + member count + colour. Mirrors
  //    mutual-k-NN's metadata so the legend is consistent across algorithms.
  const clusters = buildClusterMetadata(nodes, nodeCluster, numComponents);

  return {
    method: "hdbscan",
    params: { minSamples, numClusters },
    clusters,
    nodeCluster,
    structureEdges,
  };
}

/* ── helpers ────────────────────────────────────────────────────────────── */

function pairwiseDistances(nodes, n) {
  // Float32Array(n*n), symmetric, zero on the diagonal.
  const D = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    const pi = nodes[i].basePos;
    for (let j = i + 1; j < n; j++) {
      const pj = nodes[j].basePos;
      const dx = pi[0] - pj[0], dy = pi[1] - pj[1], dz = pi[2] - pj[2];
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz);
      D[i * n + j] = d;
      D[j * n + i] = d;
    }
  }
  return D;
}

function computeCoreDistances(dist, n, minSamples) {
  const core = new Float32Array(n);
  // k_min-th nearest neighbour: sort the (n-1) other distances, take
  // index (minSamples - 1). If minSamples is larger than the available
  // neighbours, clamp to the largest available.
  const k = Math.min(minSamples - 1, n - 2);
  const buf = new Array(n - 1);
  for (let i = 0; i < n; i++) {
    let idx = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      buf[idx++] = dist[i * n + j];
    }
    buf.sort((a, b) => a - b);
    core[i] = buf[Math.max(0, k)];
  }
  return core;
}

function primMSTMutualReach(dist, coreDist, n) {
  // Prim's algorithm on the dense graph weighted by d_mreach.
  // Standard implementation: maintain `inTree[i]`, `bestEdge[i]` (best
  // weight to reach i from the current tree), and `parent[i]` (which
  // tree node achieves that weight).
  const inTree   = new Uint8Array(n);
  const bestEdge = new Float32Array(n);
  const parent   = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    bestEdge[i] = Infinity;
    parent[i] = -1;
  }
  bestEdge[0] = 0;

  const edges = [];
  for (let iter = 0; iter < n; iter++) {
    // Pick the not-in-tree node with smallest bestEdge.
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!inTree[i] && bestEdge[i] < best) {
        best = bestEdge[i];
        u = i;
      }
    }
    if (u === -1) break;       // disconnected — shouldn't happen on a complete graph
    inTree[u] = 1;
    if (parent[u] !== -1) {
      edges.push({ i: parent[u], j: u, w: bestEdge[u] });
    }

    // Relax edges from u to all not-in-tree neighbours.
    const cu = coreDist[u];
    for (let v = 0; v < n; v++) {
      if (inTree[v] || v === u) continue;
      const d = dist[u * n + v];
      const cv = coreDist[v];
      const w = d > cu ? (d > cv ? d : cv) : (cu > cv ? cu : cv);  // max of three
      if (w < bestEdge[v]) {
        bestEdge[v] = w;
        parent[v] = u;
      }
    }
  }
  return edges;
}

function buildClusterMetadata(nodes, nodeCluster, numClusters) {
  const centroids = Array.from({ length: numClusters }, () => [0, 0, 0]);
  const counts = new Array(numClusters).fill(0);
  for (let i = 0; i < nodes.length; i++) {
    const c = nodeCluster[i];
    const p = nodes[i].basePos;
    centroids[c][0] += p[0]; centroids[c][1] += p[1]; centroids[c][2] += p[2];
    counts[c]++;
  }
  for (let c = 0; c < numClusters; c++) {
    if (counts[c] > 0) {
      centroids[c][0] /= counts[c];
      centroids[c][1] /= counts[c];
      centroids[c][2] /= counts[c];
    }
  }
  const sqDevSum = new Float64Array(numClusters);
  for (let i = 0; i < nodes.length; i++) {
    const c = nodeCluster[i];
    const p = nodes[i].basePos;
    const cc = centroids[c];
    const dx = p[0] - cc[0], dy = p[1] - cc[1], dz = p[2] - cc[2];
    sqDevSum[c] += dx*dx + dy*dy + dz*dz;
  }
  const out = [];
  for (let c = 0; c < numClusters; c++) {
    const spread = counts[c] > 0 ? Math.sqrt(sqDevSum[c] / counts[c]) : 0;
    out.push(trivialCluster(c, centroids[c], spread, counts[c]));
  }
  return out;
}

function trivialCluster(id, centre, spread, count) {
  return {
    id,
    centre: [centre[0], centre[1], centre[2]],
    spread,
    count,
    colour: TABLEAU10[id % TABLEAU10.length],
    stability: NaN,    // Stage 1 placeholder; Stage 2 fills this in
  };
}

function edgeKey(i, j) {
  return i < j ? (i + ":" + j) : (j + ":" + i);
}
