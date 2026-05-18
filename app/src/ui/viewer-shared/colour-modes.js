// Shared colour-mode helpers used by viewer-3d AND viewer-2d.
//
// The two viewers render different geometries but they're looking at
// the same data and the same node-metadata. So the dropdown options
// + the per-node colour resolver + the selection-dim logic all live
// in one place. Pulling them into a shared module means changing a
// colour rule (e.g. a new mode) updates both viewers atomically.

import { tGradient, inDegGradient, boundaryScoreGradient } from "../gradients.js";

export const DEFAULT_COLOUR_MODE = "cluster:finest";
export const DIMMED_COLOUR       = "#3a3f4a";
export const UNKNOWN_COLOUR      = "#888";

// Build the colour-by dropdown's options from the current state.
//
// "cluster:N"      → level index N
// "cluster:finest" → legacy alias for the last level (resolved
//                     downstream; not surfaced as a dropdown option)
// "origin"         → generator origin colour
// "t"              → gradient on node.t (cool → warm)
// "inDeg"          → gradient on citation in-degree (cool → warm)
// "bridge"         → bridge nodes by parent colour, others greyed
// "boundaryScore"  → gradient on per-node boundary score
export function getColourModeOptions(state) {
  const opts = [];
  const levels = state.clusterLevels || [];
  if (levels.length > 0) {
    for (let i = 0; i < levels.length; i++) {
      opts.push({
        value: `cluster:${i}`,
        label: levels.length > 1 ? `Cluster (level ${i})` : "Cluster",
      });
    }
  }
  if (state.bridgeAnalysis) {
    opts.push({ value: "bridge",        label: "Bridge clusters" });
    opts.push({ value: "boundaryScore", label: "Boundary score (gradient)" });
  }
  if (state.genResult && state.genResult.origins) {
    opts.push({ value: "origin", label: "Origin (generator label)" });
  }
  opts.push({ value: "t", label: "Time (t)" });
  if (state.citationResult) {
    opts.push({ value: "inDeg", label: "Citation in-degree" });
  }
  return opts;
}

// Resolve the cluster-result for a cluster:* mode. Returns null for
// non-cluster modes or when no clustering exists.
export function clusterResultForMode(state, mode) {
  if (!mode || !mode.startsWith("cluster")) return null;
  const levels = state.clusterLevels || [];
  if (levels.length === 0) return null;
  if (mode === "cluster:finest") return levels[levels.length - 1].clusterResult;
  const idx = parseInt(mode.slice(8), 10);
  if (Number.isFinite(idx) && idx >= 0 && idx < levels.length) {
    return levels[idx].clusterResult;
  }
  return levels[levels.length - 1].clusterResult;
}

// Resolve a node's base colour for the active mode. `node` is the
// projection the viewer puts on each datum — must carry id, originId
// (when toy), t. Cluster IDs are read from state, not the node.
export function baseColourFor(node, state, mode) {
  if (mode && mode.startsWith("cluster")) {
    const cr = clusterResultForMode(state, mode);
    if (cr) {
      const cid = cr.nodeCluster[node.id];
      const cluster = cid >= 0 ? cr.clusters[cid] : null;
      return cluster ? cluster.colour : UNKNOWN_COLOUR;
    }
    return UNKNOWN_COLOUR;
  }
  if (mode === "origin") {
    const origins = state.genResult && state.genResult.origins;
    if (origins && node.originId != null && origins[node.originId]) {
      return origins[node.originId].colour;
    }
    return UNKNOWN_COLOUR;
  }
  if (mode === "t") {
    return tGradient(+node.t || 0);
  }
  if (mode === "inDeg") {
    const cit = state.citationResult;
    if (cit && cit.inDeg) {
      let max = 1;
      for (let i = 0; i < cit.inDeg.length; i++) {
        if (cit.inDeg[i] > max) max = cit.inDeg[i];
      }
      return inDegGradient(cit.inDeg[node.id] / max);
    }
    return UNKNOWN_COLOUR;
  }
  if (mode === "bridge") {
    const ba = state.bridgeAnalysis;
    if (!ba) return UNKNOWN_COLOUR;
    if (!ba.perNodeIsBridge[node.id]) return DIMMED_COLOUR;
    const coarse = state.clusterLevels[ba.coarseLevel].clusterResult;
    const cid = coarse.nodeCluster[node.id];
    const cluster = cid >= 0 ? coarse.clusters[cid] : null;
    return cluster ? cluster.colour : UNKNOWN_COLOUR;
  }
  if (mode === "boundaryScore") {
    const ba = state.bridgeAnalysis;
    if (!ba) return UNKNOWN_COLOUR;
    return boundaryScoreGradient(ba.perNodeScore[node.id] || 0);
  }
  return UNKNOWN_COLOUR;
}

// Does this node match the user's current selection? Returns
//   true   — match, render at base colour
//   false  — non-match, render dimmed
//   null   — selection type doesn't dim (e.g. tBin), use base
export function nodeMatchesSelection(node, state, sel) {
  if (!sel || !sel.type) return null;
  if (sel.type === "cluster") {
    const levels = state.clusterLevels || [];
    if (levels.length === 0) return null;
    const lvlIdx = (sel.level == null)
      ? levels.length - 1
      : Math.max(0, Math.min(levels.length - 1, sel.level));
    const cl = levels[lvlIdx];
    if (!cl) return null;
    return cl.clusterResult.nodeCluster[node.id] === sel.id;
  }
  if (sel.type === "origin") {
    return node.originId === sel.id;
  }
  if (sel.type === "node") {
    return node.id === sel.id;
  }
  return null;
}

// Final node colour = base ± selection dim. The single function
// each viewer calls per node per frame.
export function nodeColourFor(node, state, mode) {
  const base = baseColourFor(node, state, mode);
  const matched = nodeMatchesSelection(node, state, state.selection);
  if (matched === null) return base;
  return matched ? base : DIMMED_COLOUR;
}
