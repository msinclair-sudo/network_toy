// Clustering layer.
//
// Pure function: given a generation result, recover cluster IDs by building a
// mutual k-NN graph over basePos and taking its connected components.
//
// Math reference: doc/dynamics.md §2.
//
// Reads basePos only. Does NOT touch originId. Does NOT mutate the input.
// Returns its own payload — the caller decides whether/how to attach the
// cluster IDs to its node objects.
//
// Output shape:
//   {
//     mutualK,                            the K used (clamped)
//     clusters: [{                        one entry per connected component
//       id, centre:[x,y,z], spread, count, colour
//     }],
//     nodeCluster: Int32Array,            nodeCluster[i] = cluster id for node i
//     mutualEdges: [[i,j], ...],          undirected pair list of mutual k-NN edges
//                                          (kept for debug viz; not used downstream)
//   }

const TABLEAU10 = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ab",
];

export const defaultClusteringParams = () => ({
  mutualK: 5,
});

export function inferClusters(genResult, params = {}) {
  const nodes = genResult.nodes;
  const n = nodes.length;
  const K = Math.max(1, Math.min(Math.max(1, n - 1), (params.mutualK ?? 5) | 0));

  if (n === 0) {
    return { mutualK: K, clusters: [], nodeCluster: new Int32Array(0), mutualEdges: [] };
  }

  // 1. For each node, find its top-K nearest neighbours by basePos distance.
  //    Sort the (n-1) candidates by squared distance, take the first K.
  const topK = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = nodes[i].basePos;
    const dists = new Array(n - 1);
    let idx = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const b = nodes[j].basePos;
      const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
      dists[idx++] = [dx*dx + dy*dy + dz*dz, j];
    }
    dists.sort((p, q) => p[0] - q[0]);
    const set = new Set();
    for (let k = 0; k < Math.min(K, dists.length); k++) set.add(dists[k][1]);
    topK[i] = set;
  }

  // 2. Build the mutual k-NN graph and find connected components via union-find.
  //    Edge (i,j) exists iff j ∈ topK(i) AND i ∈ topK(j).
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const mutualEdges = [];
  for (let i = 0; i < n; i++) {
    for (const j of topK[i]) {
      if (j > i && topK[j].has(i)) {
        union(i, j);
        mutualEdges.push([i, j]);
      }
    }
  }

  // 3. Compress roots → contiguous cluster labels [0..numClusters).
  const roots = new Map();
  let numClusters = 0;
  const nodeCluster = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!roots.has(r)) roots.set(r, numClusters++);
    nodeCluster[i] = roots.get(r);
  }

  // 4. Per-cluster centroid + RMS spread + member count.
  const centroids = Array.from({ length: numClusters }, () => [0, 0, 0]);
  const counts = new Array(numClusters).fill(0);
  for (let i = 0; i < n; i++) {
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
  for (let i = 0; i < n; i++) {
    const c = nodeCluster[i];
    const p = nodes[i].basePos;
    const cc = centroids[c];
    const dx = p[0] - cc[0], dy = p[1] - cc[1], dz = p[2] - cc[2];
    sqDevSum[c] += dx*dx + dy*dy + dz*dz;
  }
  const clusters = [];
  for (let c = 0; c < numClusters; c++) {
    const spread = counts[c] > 0 ? Math.sqrt(sqDevSum[c] / counts[c]) : 0;
    clusters.push({
      id: c,
      centre: centroids[c],
      spread,
      count: counts[c],
      colour: TABLEAU10[c % TABLEAU10.length],
    });
  }

  return { mutualK: K, clusters, nodeCluster, mutualEdges };
}
