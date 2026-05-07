// Clustering layer — HDBSCAN.
//
// Stage 2 (canonical extraction):
//   - Core distances + mutual reachability + MST.
//   - Build a binary dendrogram from the MST edges in ascending weight
//     order. Each merge becomes a node with `deathLambda = 1 / weight`.
//   - Walk the dendrogram top-down (root → leaves) and build a CONDENSED
//     tree by gating splits on `min_cluster_size`: real splits only
//     happen when both sides reach the threshold. Otherwise the smaller
//     side dissolves into noise w.r.t. the parent.
//   - Compute per-cluster STABILITY = Σ_p (λ_p_falls_out − λ_birth_C)
//     over the cluster's points.
//   - EOM extraction: bottom-up greedy. Select C if S(C) > Σ children's
//     selected stability; else pass children's selection through.
//   - Points outside any selected cluster are noise; at Stage 2 (no
//     `allowsNoise` yet) they get bucketed into a single trailing
//     "everything else" cluster so the contract holds.
//
// Math + algorithm reference: doc/clustering.md §4.2.
// Output contract: doc/clustering.md §1, validated by contracts/cluster.js.
//
// Reads basePos only. Does NOT mutate the input. Always satisfies the
// shared cluster-output contract — the caller can swap this with
// mutual-k-NN with no other code changes.

const TABLEAU10 = [
  "#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f",
  "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ab",
];

export const defaultHdbscanParams = () => ({
  minSamples: 5,
  minClusterSize: 5,
});

export function inferHdbscan(genResult, params = {}) {
  const nodes = genResult.nodes;
  const n = nodes.length;
  const minSamples     = Math.max(1, Math.min(Math.max(1, n - 1), (params.minSamples ?? 5) | 0));
  const minClusterSize = Math.max(2, Math.min(Math.max(2, n), (params.minClusterSize ?? 5) | 0));

  if (n === 0) {
    return {
      method: "hdbscan",
      params: { minSamples, minClusterSize },
      clusters: [],
      nodeCluster: new Int32Array(0),
      structureEdges: [],
    };
  }
  if (n === 1) {
    return {
      method: "hdbscan",
      params: { minSamples, minClusterSize },
      clusters: [trivialCluster(0, nodes[0].basePos, 0, 1, NaN)],
      nodeCluster: new Int32Array([0]),
      structureEdges: [],
    };
  }

  // 1. Pairwise Euclidean distance matrix on basePos.
  const dist = pairwiseDistances(nodes, n);

  // 2. Core distance per node = distance to the k_min-th nearest other node.
  const coreDist = computeCoreDistances(dist, n, minSamples);

  // 3. Prim's MST under d_mreach(i,j) = max(coreDist(i), coreDist(j), dist(i,j)).
  //    Returned in the order Prim's picked them (≈ ascending weight, but not
  //    strictly), so we sort ascending below.
  const mstEdges = primMSTMutualReach(dist, coreDist, n);
  const mstAsc = mstEdges.slice().sort((a, b) => a.w - b.w);

  // 4. Build the dendrogram. Each merge gets node id ≥ n; leaves are
  //    [0, n). For each internal node we track:
  //      - members[]: every leaf id under this subtree (used for the
  //        condensation pass)
  //      - deathWeight: the d_mreach at which this merge happened
  //      - left / right: child node ids
  //    "Dead" merge → for its members, λ_falls_out = 1 / deathWeight.
  const dendro = buildDendrogram(mstAsc, n);

  // 5. Condense the dendrogram into a tree of "real" cluster nodes,
  //    gated by minClusterSize. See the function comment for the rules.
  const condensed = condenseDendrogram(dendro, n, minClusterSize);

  // 6. Compute stability for every condensed cluster.
  computeStabilities(condensed);

  // 7. EOM cluster selection.
  const selectedNodes = eomSelect(condensed);

  // 8. Assign labels. Every leaf inside a selected condensed node gets
  //    that node's label; everything else is noise. At Stage 2 noise
  //    becomes a single trailing "noise" cluster (no `-1` ids until
  //    Stage 3 when allowsNoise flips true).
  const { nodeCluster, numStableClusters, hasNoise } =
        assignLabelsStage2(selectedNodes, condensed, n);

  // 9. Build the per-cluster metadata. Stable clusters first, in the
  //    order they were assigned (matches the contract: clusters[c].id === c).
  //    Noise bucket appended last with a fixed grey colour.
  const stabilityById = new Map();
  for (const cn of selectedNodes) {
    stabilityById.set(cn.label, cn.stability);
  }
  const clusters = [];
  for (let c = 0; c < numStableClusters; c++) {
    const stab = stabilityById.has(c) ? stabilityById.get(c) : NaN;
    clusters.push(buildClusterEntry(nodes, nodeCluster, c, c, stab));
  }
  if (hasNoise) {
    // Noise bucket: id stays a contiguous integer at Stage 2 (numStableClusters);
    // at Stage 3 it'll switch to id = -1.
    const noiseId = numStableClusters;
    const noiseCluster = buildClusterEntry(nodes, nodeCluster, noiseId, noiseId, NaN);
    noiseCluster.colour = "#7a8090";   // fixed noise grey
    clusters.push(noiseCluster);
  }

  // 10. structureEdges = the full MST. The MST is the structural backbone
  //     the algorithm reasoned over, which is what the debug overlay should
  //     visualise now that K is no longer a user knob.
  const structureEdges = mstEdges.map(e => [Math.min(e.i, e.j), Math.max(e.i, e.j)]);

  return {
    method: "hdbscan",
    params: { minSamples, minClusterSize },
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

// Build a per-cluster metadata entry by scanning nodes whose nodeCluster
// matches the requested clusterValue. Centred + RMS spread + count, with
// the caller's chosen `id` and `stability` (NaN for noise / mutual-k-NN).
function buildClusterEntry(nodes, nodeCluster, clusterValue, id, stability) {
  let cx = 0, cy = 0, cz = 0, count = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodeCluster[i] !== clusterValue) continue;
    const p = nodes[i].basePos;
    cx += p[0]; cy += p[1]; cz += p[2];
    count++;
  }
  if (count > 0) { cx /= count; cy /= count; cz /= count; }
  let sqDev = 0;
  for (let i = 0; i < nodes.length; i++) {
    if (nodeCluster[i] !== clusterValue) continue;
    const p = nodes[i].basePos;
    const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
    sqDev += dx*dx + dy*dy + dz*dz;
  }
  const spread = count > 0 ? Math.sqrt(sqDev / count) : 0;
  return trivialCluster(id, [cx, cy, cz], spread, count, stability);
}

function trivialCluster(id, centre, spread, count, stability) {
  return {
    id,
    centre: [centre[0], centre[1], centre[2]],
    spread,
    count,
    colour: TABLEAU10[((id % TABLEAU10.length) + TABLEAU10.length) % TABLEAU10.length],
    stability,
  };
}

/* ── dendrogram + condensed tree + EOM ─────────────────────────────────── */

// Build the binary dendrogram from MST edges (ascending weight). Each merge
// produces an internal node with id n + k (for k-th merge). Leaves get ids
// [0, n). Each internal node tracks its children plus the weight at which
// the merge happened (= 1 / λ for that merge).
//
// Returns an array indexed by node id. Leaf entries are minimal stubs;
// internal entries carry { isLeaf:false, left, right, weight }.
function buildDendrogram(mstAsc, n) {
  const totalNodes = n + mstAsc.length;
  const tree = new Array(totalNodes);
  for (let i = 0; i < n; i++) {
    tree[i] = { id: i, isLeaf: true, parent: -1 };
  }
  // Component representative tracking — initially each leaf maps to itself.
  // After merging, both sides' rep is updated to point at the new internal
  // node. Path compression keeps lookups fast.
  const rep = new Int32Array(totalNodes).fill(-1);
  for (let i = 0; i < n; i++) rep[i] = i;
  const findRep = (i) => {
    let cur = i;
    while (rep[cur] !== cur) cur = rep[cur];
    // path compression
    let walk = i;
    while (rep[walk] !== cur) { const next = rep[walk]; rep[walk] = cur; walk = next; }
    return cur;
  };

  for (let k = 0; k < mstAsc.length; k++) {
    const e = mstAsc[k];
    const ra = findRep(e.i);
    const rb = findRep(e.j);
    const newId = n + k;
    tree[newId] = {
      id: newId,
      isLeaf: false,
      left: ra,
      right: rb,
      weight: e.w,            // d_mreach
      parent: -1,
    };
    rep[ra] = newId;
    rep[rb] = newId;
    rep[newId] = newId;
    tree[ra].parent = newId;
    tree[rb].parent = newId;
  }
  return tree;
}

// Compute, for every dendrogram node, the array of leaf ids beneath it.
// This is reused by condensation and stability.
function computeLeafLists(dendro, n) {
  const leaves = new Array(dendro.length);
  for (let i = 0; i < dendro.length; i++) {
    if (dendro[i].isLeaf) leaves[i] = [i];
  }
  // Internal nodes are appended to dendro in build order, so all children
  // already have leaves[] populated by the time we visit them.
  for (let i = n; i < dendro.length; i++) {
    leaves[i] = leaves[dendro[i].left].concat(leaves[dendro[i].right]);
  }
  return leaves;
}

// Walk the dendrogram from the root downward, building the condensed tree.
//
// At each internal dendrogram node we have left/right children. Three cases:
//   (1) Both sides have ≥ minClusterSize leaves
//        → real split. Both sides become condensed-tree nodes with
//          birthLambda = 1 / dendro_node.weight.
//   (2) Both sides have < minClusterSize
//        → cluster dies here. All leaves below this dendrogram node become
//          noise w.r.t. the parent condensed cluster (their λ_falls_out =
//          1 / dendro_node.weight).
//   (3) One side ≥ threshold, other side <
//        → persistence. The big side continues as the parent's condensed
//          cluster. The small side's leaves fall out as noise w.r.t. the
//          parent (λ_falls_out = 1 / dendro_node.weight).
//
// Output: array of condensed-tree nodes. Each has:
//   {
//     id,                 // internal id, contiguous from 0
//     parentId,           // condensed-tree parent, or -1 for root cluster
//     dendroId,           // the dendrogram node where this cluster was born
//     birthLambda,        // λ at which this cluster came into existence
//     leafEvents: [{ leafId, fallsOutLambda }, ...],
//                         // every point that ever belonged to this cluster
//                         //   and the λ at which it left (either through
//                         //   small-side persistence or final split)
//     childIds: [],       // condensed-tree children
//     stability,          // filled by computeStabilities()
//     label,              // filled by assignLabelsStage2() with the cluster id
//   }
function condenseDendrogram(dendro, n, minClusterSize) {
  const leaves = computeLeafLists(dendro, n);
  const condensed = [];

  // Root of the dendrogram is the last internal node added.
  // Special edge case: n === 1 → no internal nodes. Caller handles this.
  if (dendro.length <= n) return condensed;
  const rootDendroId = dendro.length - 1;

  // The root cluster is born at λ = 0 (i.e. weight = ∞) by convention —
  // it always exists. Birth lambda = 0 means stability contributions
  // start from the moment a leaf first leaves a child of root.
  const rootCondensed = makeCondensedNode(condensed, -1, rootDendroId, 0);

  // Recursive descent. At each call we have:
  //   cdId      — condensed-tree id we're currently filling
  //   dnodeId   — the dendrogram node we're visiting next (a child of the
  //               condensed cluster's birth dendro node)
  //   parentDeathWeight — the d_mreach at which this branch was last split.
  //                       Determines the λ_falls_out for any leaf that exits
  //                       at this point.
  // Returns nothing; mutates condensed.
  function visit(cdId, dnodeId) {
    const cnode = dendro[dnodeId];
    if (cnode.isLeaf) {
      // A single point. It "falls out" of the condensed cluster the moment
      // we recurse into it. Caller handles the leafEvents push.
      return;
    }
    const left = cnode.left, right = cnode.right;
    const leftN = leaves[left].length;
    const rightN = leaves[right].length;
    const dieLambda = cnode.weight > 0 ? (1 / cnode.weight) : Infinity;

    const leftBig = leftN >= minClusterSize;
    const rightBig = rightN >= minClusterSize;

    if (leftBig && rightBig) {
      // True split. Spawn two new condensed clusters and recurse into
      // each side. makeCondensedNode wires childIds on the parent.
      const leftCd = makeCondensedNode(condensed, cdId, left, dieLambda);
      const rightCd = makeCondensedNode(condensed, cdId, right, dieLambda);
      visit(leftCd, left);
      visit(rightCd, right);
    } else if (!leftBig && !rightBig) {
      // Both small — entire branch dies. Every leaf under this dendro node
      // falls out of the parent condensed cluster at dieLambda.
      for (const leafId of leaves[dnodeId]) {
        condensed[cdId].leafEvents.push({ leafId, fallsOutLambda: dieLambda });
      }
    } else {
      // One side persists. The small side's leaves fall out at dieLambda.
      // The big side's leaves continue belonging to this condensed cluster;
      // we recurse into the big side without spawning new clusters.
      const big   = leftBig ? left : right;
      const small = leftBig ? right : left;
      for (const leafId of leaves[small]) {
        condensed[cdId].leafEvents.push({ leafId, fallsOutLambda: dieLambda });
      }
      visit(cdId, big);
    }
  }

  visit(rootCondensed, rootDendroId);

  // Any leaves that never "fell out" (because the entire dendrogram below
  // their condensed cluster was their cluster) fell out at λ = ∞.
  // Equivalently, they survived until the data ran out. For stability they
  // contribute (∞ − birthLambda), which is meaningless. Standard HDBSCAN
  // treats this case by capping λ at the maximum λ observed in the tree,
  // i.e. the death lambda of the deepest split below the cluster — but
  // for a leaf that never fell out, that's the maximum of its own line.
  //
  // Practical fix: any leaf in `leaves[birthDendroIdOfCondensedCluster]`
  // not present in leafEvents is assigned fallsOutLambda = the largest
  // lambda observed anywhere in the cluster's leafEvents (or birthLambda
  // if there are none — in which case its stability contribution is 0).
  const seenInEvents = condensed.map(() => new Set());
  for (let c = 0; c < condensed.length; c++) {
    for (const ev of condensed[c].leafEvents) seenInEvents[c].add(ev.leafId);
  }
  for (let c = 0; c < condensed.length; c++) {
    const cn = condensed[c];
    const leavesUnder = leaves[cn.dendroId];
    let maxLambda = cn.birthLambda;
    for (const ev of cn.leafEvents) {
      if (ev.fallsOutLambda > maxLambda && ev.fallsOutLambda !== Infinity) {
        maxLambda = ev.fallsOutLambda;
      }
    }
    for (const leafId of leavesUnder) {
      if (!seenInEvents[c].has(leafId)) {
        cn.leafEvents.push({ leafId, fallsOutLambda: maxLambda });
      }
    }
  }
  return condensed;
}

function makeCondensedNode(condensed, parentId, dendroId, birthLambda) {
  const id = condensed.length;
  const node = {
    id,
    parentId,
    dendroId,
    birthLambda,
    leafEvents: [],
    childIds: [],
    stability: 0,
    label: -1,
  };
  condensed.push(node);
  if (parentId >= 0) condensed[parentId].childIds.push(id);
  return id;
}

// Stability per condensed cluster:
//   stability(C) = Σ_p (λ_p_falls_out − λ_birth(C))
function computeStabilities(condensed) {
  for (const cn of condensed) {
    let s = 0;
    for (const ev of cn.leafEvents) {
      const fall = ev.fallsOutLambda === Infinity ? cn.birthLambda : ev.fallsOutLambda;
      s += Math.max(0, fall - cn.birthLambda);
    }
    cn.stability = s;
  }
}

// EOM cluster selection. Bottom-up: for each node, compare its own
// stability vs the sum of the selected stability across its children.
// Returns the array of selected condensed nodes.
function eomSelect(condensed) {
  if (condensed.length === 0) return [];
  // Process nodes in reverse-id order; descendants always have higher ids
  // (we always created children after parents... actually we create them
  // BEFORE parents in this implementation since parents are spawned at
  // splits and children spawn during the recursion. Compute order safely
  // by leaf-distance from root — easier to just compute selection bottom
  // up via a recursive post-order traversal.)
  const selectedStability = new Array(condensed.length).fill(0);
  const isSelected = new Array(condensed.length).fill(false);

  // We need to process leaves of the condensed tree first.
  function postOrder(id) {
    const cn = condensed[id];
    let childSum = 0;
    for (const cid of cn.childIds) {
      postOrder(cid);
      childSum += selectedStability[cid];
    }
    if (cn.childIds.length === 0) {
      // Leaf condensed cluster — always candidate; its selectedStability is its own stability.
      isSelected[id] = true;
      selectedStability[id] = cn.stability;
    } else if (cn.stability > childSum) {
      // Select self, deselect descendants.
      deselectDescendants(id);
      isSelected[id] = true;
      selectedStability[id] = cn.stability;
    } else {
      // Pass children's selection through.
      isSelected[id] = false;
      selectedStability[id] = childSum;
    }
  }
  function deselectDescendants(id) {
    for (const cid of condensed[id].childIds) {
      isSelected[cid] = false;
      selectedStability[cid] = 0;
      deselectDescendants(cid);
    }
  }

  // Start from the root (id 0).
  postOrder(0);

  // EOM convention: never select the root cluster itself (the whole-data
  // catchall). If the root happened to be picked, drop it and pass through
  // its children's selection — otherwise everything is "one big cluster"
  // and we lose the point of the algorithm.
  if (isSelected[0] && condensed[0].childIds.length > 0) {
    isSelected[0] = false;
    for (const cid of condensed[0].childIds) {
      reSelectIfDeselected(cid, isSelected, condensed, selectedStability);
    }
  }

  const out = [];
  for (let i = 0; i < condensed.length; i++) if (isSelected[i]) out.push(condensed[i]);
  return out;
}

// When un-selecting the root, re-run the same EOM rule on each child. If
// the child had been deselected because its parent was selected, it now
// needs to be reconsidered.
function reSelectIfDeselected(id, isSelected, condensed, selectedStability) {
  if (isSelected[id]) return;
  const cn = condensed[id];
  let childSum = 0;
  for (const cid of cn.childIds) childSum += selectedStability[cid];
  if (cn.childIds.length === 0 || cn.stability > childSum) {
    // Select self, descendants stay deselected.
    isSelected[id] = true;
    selectedStability[id] = cn.stability;
  } else {
    // Pass through to children.
    selectedStability[id] = childSum;
    for (const cid of cn.childIds) {
      reSelectIfDeselected(cid, isSelected, condensed, selectedStability);
    }
  }
}

// Given the selected condensed nodes, label every input point. Stage 2
// writes labels [0..numStableClusters) for stable points and
// numStableClusters for noise points (so contract still holds without
// allowNoise being set).
function assignLabelsStage2(selectedNodes, condensed, n) {
  const labels = new Int32Array(n).fill(-1);

  // For each selected cluster, every leaf reachable by walking down the
  // condensed tree from that cluster (including children of children, but
  // bounded by other selected clusters) belongs to the cluster.
  //
  // Simpler equivalent: a leaf belongs to its NEAREST selected ancestor
  // in the condensed tree. We walk every leaf event of every condensed
  // node and check whether that node (or any selected ancestor of it)
  // is selected.
  //
  // But leafEvents only contains points that LEFT the cluster — points
  // that survived to the cluster's leaves are also in the cluster. We
  // need the union of all leaves under each condensed node, intersected
  // with the leaves of the selected ancestor-most node.
  //
  // Cleanest approach: for every selected cluster, walk down the
  // condensed tree from it and collect leaves that aren't claimed by a
  // selected descendant. To make that easy, label each leaf by its
  // "owning" condensed cluster — which is the deepest selected ancestor.
  const isSelected = new Array(condensed.length).fill(false);
  for (const cn of selectedNodes) isSelected[cn.id] = true;

  // Map condensed cluster id → assigned label (only filled for selected).
  let nextLabel = 0;
  const assigned = new Map();
  for (const cn of selectedNodes) {
    cn.label = nextLabel;
    assigned.set(cn.id, nextLabel);
    nextLabel++;
  }
  const numStableClusters = nextLabel;

  // Walk every condensed cluster; for each leafEvent (point that "passed
  // through" this cluster on its way to falling out), the point's owning
  // cluster is the deepest selected ancestor — i.e. this cluster if it's
  // selected, else the nearest selected ancestor. If no selected ancestor
  // exists, the point is noise.
  function deepestSelectedAncestor(cdId) {
    let cur = cdId;
    while (cur !== -1) {
      if (isSelected[cur]) return cur;
      cur = condensed[cur].parentId;
    }
    return -1;
  }
  for (const cn of condensed) {
    const ownerCdId = deepestSelectedAncestor(cn.id);
    if (ownerCdId === -1) continue;
    const ownerLabel = assigned.get(ownerCdId);
    for (const ev of cn.leafEvents) {
      if (labels[ev.leafId] === -1) labels[ev.leafId] = ownerLabel;
    }
  }

  // Anything still -1 is noise. At Stage 2 we move noise into a single
  // trailing bucket (id = numStableClusters) because the contract doesn't
  // yet allow -1 (Stage 3 flips allowsNoise true).
  let hasNoise = false;
  for (let i = 0; i < n; i++) {
    if (labels[i] === -1) {
      labels[i] = numStableClusters;
      hasNoise = true;
    }
  }
  return { nodeCluster: labels, numStableClusters, hasNoise };
}
