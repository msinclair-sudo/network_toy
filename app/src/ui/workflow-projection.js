// Workflow-tree projection layer — Phase 2 slice 2.7.
//
// Bridges the new tree-shaped state.workflow with the legacy singular
// slots (state.dimredResult / state.clusterLevels / state._basePos /
// etc.) that every existing panel + viewer still reads.
//
// When the user selects a tree card, we walk the ancestry from the
// root to that card, collect each step's snapshotted result, and
// patch the legacy slots accordingly. Existing panels keep their
// existing read API; the underlying data is now selection-driven.
//
// Self-contained module:
//   - Inputs: stepId (from selectStep callers).
//   - Side effects: update() on state with the projected slots +
//     engineRevision bump (so viewers that watch engineRevision
//     re-paint).
//   - No reads outside workflow.js + state.js.

import { getState, update }    from "./state.js";
import { getStepAncestors }    from "./workflow.js";

// Each step type knows which legacy state slots to project. The walk
// applies these projectors from root to selected step in order, so
// deeper ancestors overwrite shallower (which is the right semantics
// for the linear pipeline — clustering's result wins over dimred for
// state.clusterLevels, etc.; their result spaces don't overlap so the
// order doesn't matter in practice but keeping it explicit is cleaner).
const PROJECTORS = {
  data:           (step, patch) => projectData(step, patch),
  dimred:         (step, patch) => projectDimred(step, patch),
  clustering:     (step, patch) => projectClustering(step, patch),
  citations:      (step, patch) => projectCitations(step, patch),
  citationLayout: (step, patch) => projectCitationLayout(step, patch),
  alignment:      (step, patch) => projectAlignment(step, patch),
  blend:          (step, patch) => projectBlend(step, patch),
};

function projectData(step, patch) {
  // Data root is mostly descriptive in the migration; genResult /
  // embedding / dataSource etc. are already loaded into legacy state
  // and not re-projected here. (Switching data sources rebuilds the
  // workflow entirely via dataDescriptor.applyChange.)
  if (!step.result) return;
}

function projectDimred(step, patch) {
  const r = step.result;
  if (!r) return;
  // Migration-time results use field names like `basePos` / `basePos2d`
  // (no underscores) per workflow-migration.js. createAndRunStep
  // snapshots use the canonical underscore-prefixed legacy names.
  // Handle both.
  if (r.dimredResult)                patch.dimredResult         = r.dimredResult;
  if (r._basePos    !== undefined)   patch._basePos             = r._basePos;
  if (r.basePos     !== undefined && r._basePos === undefined) patch._basePos = r.basePos;
  if (r._basePos2d  !== undefined)   patch._basePos2d           = r._basePos2d;
  if (r.basePos2d   !== undefined && r._basePos2d === undefined) patch._basePos2d = r.basePos2d;
  if (r.dimredResultPreFusion !== undefined) patch.dimredResultPreFusion = r.dimredResultPreFusion;
  if (r._basePosPreFusion !== undefined)     patch._basePosPreFusion     = r._basePosPreFusion;
}

function projectClustering(step, patch) {
  const r = step.result;
  if (!r) return;
  if (r.clusterLevels)                       patch.clusterLevels = r.clusterLevels;
  if (r.clusterResult)                       patch.clusterResult = r.clusterResult;
  if (r.clusterLevelsPreFusion !== undefined) patch.clusterLevelsPreFusion = r.clusterLevelsPreFusion;
  if (r.clusterResultPreFusion !== undefined) patch.clusterResultPreFusion = r.clusterResultPreFusion;
  if (r.bridgeAnalysis         !== undefined) patch.bridgeAnalysis = r.bridgeAnalysis;
}

function projectCitations(step, patch) {
  const r = step.result;
  if (!r) return;
  if (r.citationResult) patch.citationResult = r.citationResult;
}

function projectCitationLayout(step, patch) {
  const r = step.result;
  if (!r) return;
  if (r.citationLayout)                    patch.citationLayout        = r.citationLayout;
  if (r.alignedCitationLayout)             patch.alignedCitationLayout = r.alignedCitationLayout;
  if (r.alignmentCorrelation !== undefined) patch.alignmentCorrelation = r.alignmentCorrelation;
}

function projectAlignment(step, patch) {
  const r = step.result;
  if (!r) return;
  if (r.alignedCitationLayout) patch.alignedCitationLayout = r.alignedCitationLayout;
  if (r.alignmentCorrelation !== undefined) patch.alignmentCorrelation = r.alignmentCorrelation;
}

function projectBlend(step, patch) {
  const r = step.result;
  if (!r) return;
  if (typeof r.alpha === "number") patch.blend = r.alpha;
}

/**
 * Walk the ancestry from root → stepId, accumulate per-step
 * projections into a patch, and apply via `update`. Bumps
 * engineRevision so subscribers that watch it (viewer-3d/2d) re-paint.
 *
 * @param {string} stepId
 * @returns {boolean} true if the patch was non-empty (i.e. data
 *                    actually changed), false otherwise.
 */
export function projectStepIntoLegacyState(stepId) {
  const ancestors = getStepAncestors(stepId);
  if (ancestors.length === 0) return false;
  const patch = {};
  for (const step of ancestors) {
    const projector = PROJECTORS[step.type];
    if (projector) projector(step, patch);
  }
  // Bump engineRevision so viewers re-paint. Even an empty projection
  // bumps because the user did select a step — they expect some
  // visual confirmation. Cheap.
  patch.engineRevision = (getState().engineRevision || 0) + 1;
  update(patch);
  return Object.keys(patch).length > 1;   // > 1 because engineRevision is always added
}
