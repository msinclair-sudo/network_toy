// Per-layer descriptors that the workflow chart consumes.
//
// Each layer exposes:
//   { label, openModal: () => modalHandle }
//
// The descriptor itself decides which modal kind to open — clustering
// uses the multi-level modal; layout uses the single-level one. New
// layer kinds plug in here without touching workflow-chart.js.

import { listDataSources, getDataSource }           from "../../datasource/registry.js";
import { listAlgorithms as listDimredAlgos,
         getAlgorithm   as getDimredAlgo }         from "../../dimred/registry.js";
import { listAlgorithms as listClusteringAlgos,
         getAlgorithm   as getClusteringAlgo }     from "../../clustering-registry.js";
import { listAlgorithms as listLayoutAlgos,
         getAlgorithm   as getLayoutAlgo }         from "../../citation-layout/registry.js";
import { getState, update, setDataSourceMode, setDataSourceConfig } from "../state.js";
import { openAlgorithmModal }                       from "./algorithm-modal.js";
import { openClusteringModal }                      from "./clustering-modal.js";
import { openDimredModal }                          from "./dimred-modal.js";
import { openDataSourceModal }                      from "./data-source-modal.js";
import * as engine                                  from "../engine.js";

export function getLayerDescriptor(nodeId) {
  switch (nodeId) {
    case "data":       return dataDescriptor();
    case "dimred":     return dimredDescriptor();
    case "clustering": return clusteringDescriptor();
    case "layout":     return layoutDescriptor();
    default:           return null;
  }
}

function dataDescriptor() {
  const desc = {
    label: "Configure: Data source",
    listSources: () => listDataSources(),
    getActive: () => {
      const s = getState();
      const mode = s.dataSource.mode;
      const params = (s.dataSource.configs && s.dataSource.configs[mode]) || getDataSource(mode).defaultParams();
      return { method: mode, params: { ...params } };
    },
    applyChange: async (sourceId, params) => {
      // Persist the source choice + its params, then trigger the
      // pipeline. setDataSourceMode mirrors into both
      // dataSource.mode and activeAlgorithm.dataSource so consumers
      // reading either keep in sync. setDataSourceConfig writes
      // into configs[sourceId] specifically. Returns a promise that
      // resolves when the full reingest cascade completes — the
      // modal awaits this so its progress button stays visible
      // until the work actually finishes.
      setDataSourceMode(sourceId);
      for (const k of Object.keys(params)) {
        setDataSourceConfig(k, params[k], sourceId);
      }
      await engine.reingest();
    },
    openModal: () => openDataSourceModal(desc),
  };
  return desc;
}

function dimredDescriptor() {
  const desc = {
    label: "Configure: Dim-reduction",
    // The dim-reduction modal renders one section per stage; pass it
    // a slot-aware lister so each section's dropdown only shows the
    // matching entries (plus identity, which is "any").
    listAlgos: (slot) => listDimredAlgos(slot),
    getActive: () => {
      const lp = getState().layerParams.dimred;
      const fallbackParams = (algoId) => getDimredAlgo(algoId).defaultParams();
      const noiseM  = lp && lp.noise       ? lp.noise.method       : "identity";
      const fusionM = lp && lp.fusion      ? lp.fusion.method      : "identity";
      const compM   = lp && lp.compression ? lp.compression.method : "identity";
      const vizM    = lp && lp.viz         ? lp.viz.method         : "identity";
      const viz2dM  = lp && lp.viz2d       ? lp.viz2d.method       : "identity";
      return {
        noise:       {
          method: noiseM,
          params: (lp && lp.noise && lp.noise.params) || fallbackParams(noiseM),
        },
        fusion:      {
          method: fusionM,
          params: (lp && lp.fusion && lp.fusion.params) || fallbackParams(fusionM),
        },
        compression: {
          method: compM,
          params: (lp && lp.compression && lp.compression.params) || fallbackParams(compM),
        },
        viz: {
          method: vizM,
          params: (lp && lp.viz && lp.viz.params) || fallbackParams(vizM),
        },
        viz2d: {
          method: viz2dM,
          params: (lp && lp.viz2d && lp.viz2d.params) || fallbackParams(viz2dM),
        },
      };
    },
    applyChange: async ({ noise, fusion, compression, viz, viz2d }) => {
      const s = getState();
      update({
        layerParams: {
          ...s.layerParams,
          dimred: { noise, fusion, compression, viz, viz2d },
        },
      });
      try { await engine.redimred(); }
      catch (e) { console.error("[dimred-descriptor] redimred failed:", e); }
    },
    openModal: () => openDimredModal(desc),
  };
  return desc;
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
    applyChange: async (algoId, levels) => {
      const s = getState();
      update({
        layerParams: {
          ...s.layerParams,
          clustering: { method: algoId, levels },
        },
      });
      try { await engine.recluster(); }
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
    applyChange: async (algoId, params) => {
      const s = getState();
      update({
        layerParams: {
          ...s.layerParams,
          layout: { method: algoId, params },
        },
      });
      try { await engine.relayoutCitations(); }
      catch (e) { console.error("[layout-descriptor] relayoutCitations failed:", e); }
    },
    openModal: () => openAlgorithmModal(desc),
  };
  return desc;
}
