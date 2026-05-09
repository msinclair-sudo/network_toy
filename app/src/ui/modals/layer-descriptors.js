// Per-layer descriptors that the workflow chart consumes.
//
// Each layer exposes:
//   { label, openModal: () => modalHandle }
//
// The descriptor itself decides which modal kind to open — clustering
// uses the multi-level modal; layout uses the single-level one. New
// layer kinds plug in here without touching workflow-chart.js.

import { listAlgorithms as listClusteringAlgos,
         getAlgorithm   as getClusteringAlgo }     from "../../clustering-registry.js";
import { listAlgorithms as listLayoutAlgos,
         getAlgorithm   as getLayoutAlgo }         from "../../citation-layout/registry.js";
import { getState, update }                         from "../state.js";
import { openAlgorithmModal }                       from "./algorithm-modal.js";
import { openClusteringModal }                      from "./clustering-modal.js";
import * as engine                                  from "../engine.js";

export function getLayerDescriptor(nodeId) {
  switch (nodeId) {
    case "clustering": return clusteringDescriptor();
    case "layout":     return layoutDescriptor();
    default:           return null;
  }
}

function clusteringDescriptor() {
  const desc = {
    label: "Configure: Clustering",
    listAlgos: () => listClusteringAlgos(),
    getActive: () => {
      const lp = getState().layerParams.clustering;
      return {
        method: lp ? lp.method : "mutualKNN",
        levels: lp ? lp.levels : [
          { uid: "L0", params: getClusteringAlgo("mutualKNN").defaultParams(), scope: "global" },
        ],
      };
    },
    applyChange: (algoId, levels) => {
      const s = getState();
      update({
        layerParams: {
          ...s.layerParams,
          clustering: { method: algoId, levels },
        },
      });
      try { engine.recluster(); }
      catch (e) { console.error("[clustering-descriptor] recluster failed:", e); }
    },
    openModal: () => openClusteringModal(desc),
  };
  return desc;
}

function layoutDescriptor() {
  const desc = {
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
      catch (e) { console.error("[layout-descriptor] relayoutCitations failed:", e); }
    },
    openModal: () => openAlgorithmModal(desc),
  };
  return desc;
}
