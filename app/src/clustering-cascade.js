// Multi-level clustering cascade — shared by the main-thread engine
// (engine.js) and the clustering worker (workers/clustering-worker.js).
//
// Extracted from engine.js so the worker can run the full cascade
// inside one job: send the inputs once, get the levels[] array back
// once, no per-level postMessage chatter.
//
// Pure: no state reads, no DOM. Inputs:
//   algo          a clustering registry entry (resolves to the same
//                 module on both threads — the registry is pure)
//   nodesSlim     [{ id, basePos: [x,y,z] }] — the minimum the
//                 algorithms actually read off genResult.nodes.
//                 Anything else the algorithms used to read (`origin`,
//                 `t`, `cite`) isn't touched by the clustering layer.
//   levelCfgs     state.layerParams.clustering.levels — each level's
//                 { uid, scope, params }
//   dimredResult  the full-n DimredResult (compression slot output)
//   allowNoise    bool (read off algo.allowsNoise on the caller side)
//   n             nodes.length, for contract validation
//
// Returns: levels[] in the same shape engine.js used to produce —
// each entry { uid, scope: "global" | "within-parent", clusterResult }.

import { validateClusterResult } from "./contracts/cluster.js";

export function runClusterLevels(algo, nodesSlim, levelCfgs, dimredResult, allowNoise, n) {
  const levels = [];
  let parent = null;
  // The clustering algorithms expect a genResult-shaped object — but
  // only read .nodes off it. Build a minimal stub once.
  const genStub = { nodes: nodesSlim };
  for (let i = 0; i < levelCfgs.length; i++) {
    const lvl = levelCfgs[i];
    const isGlobal = (i === 0) || lvl.scope === "global";
    let cr;
    if (isGlobal) {
      cr = algo.infer(genStub, lvl.params, dimredResult);
    } else {
      cr = clusterWithinParents(algo, genStub, parent, lvl.params, dimredResult);
    }
    validateClusterResult(cr, n, { allowNoise });
    levels.push({ uid: lvl.uid, scope: isGlobal ? "global" : "within-parent", clusterResult: cr });
    parent = cr;
  }
  return levels;
}

// Within-parent: run the algorithm separately on each parent cluster's
// member set, stitch into a single globally-numbered ClusterResult.
// Singletons / empty parents become trivial single-cluster outputs.
function clusterWithinParents(algo, genResult, parent, params, dimredResult) {
  const n = genResult.nodes.length;
  const numParents = parent.clusters.length;
  const nodeCluster = new Int32Array(n);
  const clusters = [];
  const structureEdges = [];
  let nextId = 0;

  const byParent = Array.from({ length: numParents }, () => []);
  for (let i = 0; i < n; i++) byParent[parent.nodeCluster[i]].push(i);

  for (let p = 0; p < numParents; p++) {
    const ids = byParent[p];
    if (ids.length === 0) continue;

    if (ids.length === 1) {
      const orig = ids[0];
      const node = genResult.nodes[orig];
      nodeCluster[orig] = nextId;
      clusters.push({
        id:        nextId,
        centre:    [node.basePos[0], node.basePos[1], node.basePos[2]],
        spread:    0,
        count:     1,
        colour:    parent.clusters[p].colour,
        stability: NaN,
      });
      nextId++;
      continue;
    }

    const subNodes = ids.map((origId, localIdx) => {
      const orig = genResult.nodes[origId];
      return { ...orig, id: localIdx };
    });
    const subDimred = sliceDimred(dimredResult, ids);
    const subResult = algo.infer({ ...genResult, nodes: subNodes }, params, subDimred);

    for (let localIdx = 0; localIdx < ids.length; localIdx++) {
      const subCid = subResult.nodeCluster[localIdx];
      nodeCluster[ids[localIdx]] = subCid >= 0 ? nextId + subCid : -1;
    }
    for (const sc of subResult.clusters) {
      if (sc.id < 0) continue;
      clusters.push({ ...sc, id: nextId + sc.id });
    }
    for (const e of subResult.structureEdges) {
      structureEdges.push([ids[e[0]], ids[e[1]]]);
    }
    nextId += subResult.clusters.length;
  }

  return {
    method: parent.method,
    params,
    clusters,
    nodeCluster,
    structureEdges,
  };
}

function sliceDimred(dimredResult, ids) {
  const d   = dimredResult.d;
  const src = dimredResult.data;
  const out = new Float32Array(ids.length * d);
  for (let li = 0; li < ids.length; li++) {
    const oi = ids[li];
    for (let k = 0; k < d; k++) out[li * d + k] = src[oi * d + k];
  }
  return {
    method: dimredResult.method,
    params: dimredResult.params,
    n:      ids.length,
    d,
    data:   out,
  };
}

// Slim a full genResult.nodes array to what the clustering layer
// actually reads. Used by engine.js when building the worker payload.
// Per-node: id + basePos. Skips origin, t, embedding, citation lists.
export function slimNodesForClustering(nodes) {
  const out = new Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const bp = n.basePos || [0, 0, 0];
    out[i] = { id: n.id, basePos: [bp[0], bp[1], bp[2]] };
  }
  return out;
}
