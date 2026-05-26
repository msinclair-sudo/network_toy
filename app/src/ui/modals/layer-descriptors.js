// Per-layer descriptors that the workflow chart consumes.
//
// Each layer exposes:
//   { label, openModal: () => modalHandle, applyChange(args) → Promise }
//
// Phase 2 slice 2.5: applyChange now CREATES A NEW TREE STEP and
// enqueues a step-bound job that runs the existing engine function.
// The card represents the work that happened with these params; old
// cards stay browsable. The legacy state slots (state.dimredResult,
// state.clusterLevels, …) continue to reflect the most recent apply —
// the back-compat projection layer (slice 2.7) will swap those slots
// based on the selected card.
//
// New layer kinds plug in here without touching workflow-chart.js.

import { listDataSources, getDataSource }           from "../../datasource/registry.js";
import { listAlgorithms as listDimredAlgos,
         getAlgorithm   as getDimredAlgo }         from "../../dimred/registry.js";
import { listAlgorithms as listClusteringAlgos,
         getAlgorithm   as getClusteringAlgo }     from "../../clustering-registry.js";
import { listAlgorithms as listLayoutAlgos,
         getAlgorithm   as getLayoutAlgo }         from "../../citation-layout/registry.js";
import { getState, update, setDataSourceMode, setDataSourceConfig } from "../state.js";
import { createStep, listSteps, clearWorkflow }     from "../workflow.js";
import { enqueueJob }                              from "../queue.js";
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

// ── parent-step lookup ───────────────────────────────────────────────
//
// For each layer type, the canonical parent in the workflow tree:
//   dimred         → data
//   clustering     → dimred
//   citations      → clustering  (toy-only branch)
//   citationLayout → citations OR clustering (whichever exists)
//
// We pick the most recently-created step of the parent type — that's
// the "active" branch the user has been working on. listSteps walks
// the tree in BFS-from-root order, so the LAST entry is the latest.
//
// Returns null if no matching parent exists (e.g. dimred step before
// the data root has been migrated). Caller falls back to "no-tree"
// mode if returning null.
function findCanonicalParent(childType) {
  const parentTypeMap = {
    dimred:         "data",
    clustering:     "dimred",
    citationLayout: "citations",
  };
  const parentType = parentTypeMap[childType];
  if (!parentType) return null;
  const candidates = listSteps({ type: parentType });
  if (candidates.length > 0) return candidates[candidates.length - 1].id;
  // citationLayout's natural parent is "citations"; fall back to
  // clustering if citations isn't on the tree (real-data without
  // imported edges).
  if (childType === "citationLayout") {
    const clust = listSteps({ type: "clustering" });
    if (clust.length > 0) return clust[clust.length - 1].id;
  }
  return null;
}

// Create a tree step + enqueue a step-bound job that runs `engineFn`.
// engineFn is an async function — typically it patches state.layerParams
// then calls one of the engine.* functions. The job's fn closes over
// the patched params; the queue runner mirrors lifecycle onto the step.
//
// Slice 2.7: after engineFn returns, we SNAPSHOT the relevant state
// slots into the step's result based on its type. Each card holds a
// ref to the exact result objects it produced (the engine creates
// fresh objects on each Apply, so refs don't alias). The projection
// layer (workflow-projection.js) replays these into legacy state slots
// when the user selects the card.
//
// Returns the job's promise (resolves with the engine result when the
// step completes; rejects on failure or cancel). Modals await this so
// their Running… indicator stays visible until completion (modals that
// close on Apply just call it without awaiting).
function createAndRunStep({ type, label, params, engineFn }) {
  const parentId = findCanonicalParent(type);
  if (parentId == null) {
    // No tree yet (e.g. legacy boot path before migration runs). Fall
    // back to the legacy behaviour: just call engineFn without
    // creating a step. The chart will be silent for this work; an
    // explicit migration on the next state change will rebuild.
    return engineFn();
  }
  const stepId = createStep({ type, label, params, parentId });
  const { promise } = enqueueJob({
    type, label,
    stepId,
    fn: async (_ctx) => {
      await engineFn();
      // Snapshot the relevant state slots into the step's result, so
      // the projection layer can replay them back when this card is
      // selected later. Each engine function creates fresh objects, so
      // these refs aren't shared with other steps' results.
      return snapshotResultForType(type);
    },
  });
  return promise;
}

// Per-type snapshot — picks the state slots that "belong" to this
// layer's output. Refs are captured at the moment the engine function
// returns; subsequent Apply on a SIBLING produces a new result with
// fresh refs, so the old card's refs stay intact (immutable per §10.D1).
function snapshotResultForType(type) {
  const s = getState();
  if (type === "dimred") {
    return {
      capturedAt:            new Date().toISOString(),
      dimredResult:          s.dimredResult,
      _basePos:              s._basePos,
      _basePos2d:            s._basePos2d,
      dimredResultPreFusion: s.dimredResultPreFusion,
      _basePosPreFusion:     s._basePosPreFusion,
    };
  }
  if (type === "clustering") {
    return {
      capturedAt:             new Date().toISOString(),
      clusterLevels:          s.clusterLevels,
      clusterResult:          s.clusterResult,
      clusterLevelsPreFusion: s.clusterLevelsPreFusion,
      clusterResultPreFusion: s.clusterResultPreFusion,
      bridgeAnalysis:         s.bridgeAnalysis,
    };
  }
  if (type === "citationLayout") {
    return {
      capturedAt:            new Date().toISOString(),
      citationLayout:        s.citationLayout,
      alignedCitationLayout: s.alignedCitationLayout,
      alignmentCorrelation:  s.alignmentCorrelation,
    };
  }
  // Other types use the sentinel — the migration helper or per-type
  // builder already populated their result blob.
  return { capturedAt: new Date().toISOString() };
}

// ── descriptors ─────────────────────────────────────────────────────

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
    // Switching data sources rebuilds everything. Rather than fork a
    // new data sibling (§10.D1 says only one root), we wipe the
    // workflow + reingest. Migration on the next state change
    // rebuilds the tree under the new data root.
    applyChange: async (sourceId, params) => {
      setDataSourceMode(sourceId);
      for (const k of Object.keys(params)) {
        setDataSourceConfig(k, params[k], sourceId);
      }
      // Clear the tree so migration rebuilds cleanly. Without this,
      // findCanonicalParent would return the OLD data root, and the
      // new dimred/clustering cards would attach to a root whose
      // data no longer matches.
      clearWorkflow();
      await engine.reingest();
      // Re-trigger migration so the new tree appears immediately.
      // (workflow-chart.js's one-shot migration already ran on boot;
      // this explicit call rebuilds the tree on the new data.)
      const { migrateLegacyToWorkflowIfNeeded } =
        await import("../workflow-migration.js");
      migrateLegacyToWorkflowIfNeeded();
    },
    openModal: () => openDataSourceModal(desc),
  };
  return desc;
}

function dimredDescriptor() {
  const desc = {
    label: "Configure: Dim-reduction",
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
      const dimredParams = { noise, fusion, compression, viz, viz2d };
      const label = `Dim-reduce · ${compression.method} → ${viz.method}`;
      return createAndRunStep({
        type:   "dimred",
        label,
        params: dimredParams,
        engineFn: async () => {
          const s = getState();
          update({ layerParams: { ...s.layerParams, dimred: dimredParams } });
          try { await engine.redimred(); }
          catch (e) { console.error("[dimred-descriptor] redimred failed:", e); throw e; }
        },
      });
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
    // applyChange(algoId, levels, opts?)
    // opts.precomputedCr — passed through to engine.recluster() so per-row
    //   Apply from the Optimise tab can skip the L0 algo.infer when the
    //   sweep already produced a matching cr (A3, §6.18.3).
    applyChange: async (algoId, levels, opts = {}) => {
      const clusteringParams = { method: algoId, levels };
      const lvlCount = (levels || []).length;
      const label = lvlCount > 1
        ? `Clustering · ${algoId} · ${lvlCount} levels`
        : `Clustering · ${algoId}`;
      return createAndRunStep({
        type:   "clustering",
        label,
        params: clusteringParams,
        engineFn: async () => {
          const s = getState();
          update({ layerParams: { ...s.layerParams, clustering: clusteringParams } });
          try { await engine.recluster({ precomputedCr: opts.precomputedCr || null }); }
          catch (e) { console.error("[clustering-descriptor] recluster failed:", e); throw e; }
        },
      });
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
      const layoutParams = { method: algoId, params };
      const label = `Citation layout · ${algoId}`;
      return createAndRunStep({
        type:   "citationLayout",
        label,
        params: layoutParams,
        engineFn: async () => {
          const s = getState();
          update({ layerParams: { ...s.layerParams, layout: layoutParams } });
          try { await engine.relayoutCitations(); }
          catch (e) { console.error("[layout-descriptor] relayoutCitations failed:", e); throw e; }
        },
      });
    },
    openModal: () => openAlgorithmModal(desc),
  };
  return desc;
}
