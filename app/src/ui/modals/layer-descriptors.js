// Per-layer descriptors that the algorithm modal consumes.
//
// Each layer has its own state shape (clustering uses byAlgo map,
// layout uses single params object) and its own engine lane to
// trigger after a change. This file centralises the per-layer glue
// so workflow-chart.js doesn't grow a switch on layer id.

import { listAlgorithms as listClusteringAlgos,
         getAlgorithm   as getClusteringAlgo }     from "../../clustering-registry.js";
import { listAlgorithms as listLayoutAlgos,
         getAlgorithm   as getLayoutAlgo }         from "../../citation-layout/registry.js";
import { getState, update }                         from "../state.js";
import * as engine                                  from "../engine.js";

export function getLayerDescriptor(nodeId) {
  switch (nodeId) {
    case "clustering": return clusteringDescriptor();
    case "layout":     return layoutDescriptor();
    default:           return null;
  }
}

function clusteringDescriptor() {
  return {
    layer: "clustering",
    label: "Configure: Clustering",
    listAlgos: () => listClusteringAlgos(),
    getActive: () => {
      const lp = getState().layerParams.clustering;
      const method = lp ? lp.method : "mutualKNN";
      const params = lp && lp.byAlgo[method] ? lp.byAlgo[method] : getClusteringAlgo(method).defaultParams();
      return { method, params };
    },
    applyChange: (algoId, params) => {
      const s = getState();
      const cur = s.layerParams.clustering;
      const byAlgo = { ...(cur ? cur.byAlgo : {}), [algoId]: params };
      update({
        layerParams: {
          ...s.layerParams,
          clustering: { method: algoId, byAlgo },
        },
      });
      // Cascade from Layer 2 down.
      try { engine.recluster(); }
      catch (e) { console.error("[layer-descriptor] recluster failed:", e); }
    },
  };
}

function layoutDescriptor() {
  return {
    layer: "layout",
    label: "Configure: Citation layout",
    listAlgos: () => listLayoutAlgos(),
    getActive: () => {
      const lp = getState().layerParams.layout;
      const method = lp ? lp.method : "fruchterman-reingold";
      const params = lp && lp.params ? lp.params : getLayoutAlgo(method).defaultParams();
      return { method, params };
    },
    applyChange: (algoId, params) => {
      const s = getState();
      update({
        layerParams: {
          ...s.layerParams,
          layout: { method: algoId, params },
        },
      });
      try { engine.relayoutCitations(); }
      catch (e) { console.error("[layer-descriptor] relayoutCitations failed:", e); }
    },
  };
}
