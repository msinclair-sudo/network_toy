// State → zip blob.
//
// Walks state, extracts every TypedArray onto a parallel "binary
// payload" map keyed by zip-relative path, and replaces each in-state
// TypedArray with a {__binary, type, length} descriptor. The walker
// is tailored to this app's state shape — generic JSON.stringify
// doesn't handle TypedArrays, and a generic walker would either pay
// a lot of overhead or miss things.
//
// The zip contains:
//   manifest.json    — schema version + inventory
//   state.json       — JSON-serialisable state, with binary descriptors
//                      pointing into arrays/
//   arrays/*.{f32,i32,u8} — raw typed-array payloads
//
// Output is a Blob ready to download.

import { zipSync, strToU8 } from "fflate";
import { buildManifest } from "./manifest.js";

// Slots saved verbatim as JSON (no typed-array surgery).
// Anything not in this list either gets specially handled below or
// is intentionally excluded (e.g. engineRevision — meaningless across
// sessions).
const PASS_THROUGH_KEYS = [
  "dataSource",
  "layerParams",
  "activeAlgorithm",
  "layerStates",
  "panels",
  "selection",
  "filter",
  "blend",
  "bridgeConfig",
];

// Slot keys that are excluded from the save entirely.
const EXCLUDED_KEYS = new Set([
  "engineRevision",
  // genResult, _basePos, embedding, dimredResult, clusterLevels,
  // clusterResult, bridgeAnalysis, neighbourhoodResult, tasteResult,
  // citationResult, citationLayout, alignedCitationLayout,
  // alignmentCorrelation, evalResults, projectName — all handled
  // explicitly below.
]);

export function serialiseState(state) {
  const arrays = {};   // zip-relative path -> Uint8Array
  const out = {};

  // 1. Pass-through slots (plain JSON).
  for (const k of PASS_THROUGH_KEYS) {
    if (k in state) out[k] = state[k];
  }

  // 2. genResult — nodes are JSON-friendly (origins / id / t /
  //    originId / paperId / per-node basePos arrays). Inline it.
  if (state.genResult) {
    out.genResult = state.genResult;
  }

  // 3. _basePos — flat Float32Array(n*3). Binary.
  if (state._basePos instanceof Float32Array) {
    out._basePos = stashBinary(arrays, "arrays/basePos.f32", state._basePos);
  }
  // 3a. _basePos2d — flat Float32Array(n*2) for the 2D viewer. Null
  //     when viz2d hasn't produced a 2-d output yet.
  if (state._basePos2d instanceof Float32Array) {
    out._basePos2d = stashBinary(arrays, "arrays/basePos2d.f32", state._basePos2d);
  }

  // 4. embedding — {d, data: Float32Array(n*d)}.
  if (state.embedding && state.embedding.data instanceof Float32Array) {
    out.embedding = {
      d:    state.embedding.d,
      data: stashBinary(arrays, "arrays/embedding.f32", state.embedding.data),
    };
  }

  // 5. dimredResult — {method, params, n, d, data: Float32Array(n*d)}.
  if (state.dimredResult && state.dimredResult.data instanceof Float32Array) {
    out.dimredResult = {
      method: state.dimredResult.method,
      params: state.dimredResult.params,
      n:      state.dimredResult.n,
      d:      state.dimredResult.d,
      data:   stashBinary(arrays, "arrays/dimredResult.f32", state.dimredResult.data),
    };
  }

  // 6. clusterLevels — array of {uid, scope, clusterResult}.
  //    clusterResult.nodeCluster is Int32Array; noiseFlags (HDBSCAN
  //    only) is Uint8Array. Other fields are JSON-friendly.
  if (Array.isArray(state.clusterLevels)) {
    out.clusterLevels = state.clusterLevels.map((lvl, idx) => ({
      uid:           lvl.uid,
      scope:         lvl.scope,
      clusterResult: serialiseClusterResult(lvl.clusterResult, arrays, idx),
    }));
  }
  // clusterResult is a backward-compat alias for the finest level.
  // No need to save separately — restored from clusterLevels.

  // 7. bridgeAnalysis — {fineLevel, coarseLevel, levels, perCluster,
  //    perNodeScore: Float32Array, perNodeIsBridge: Uint8Array, ...}
  if (state.bridgeAnalysis) {
    const ba = state.bridgeAnalysis;
    out.bridgeAnalysis = {
      fineLevel:   ba.fineLevel,
      coarseLevel: ba.coarseLevel,
      levels:      ba.levels,
      perCluster:  ba.perCluster,
      bridgeCount: ba.bridgeCount,
      perNodeScore:    stashBinary(arrays, "arrays/bridge.perNodeScore.f32",    ba.perNodeScore),
      perNodeIsBridge: stashBinary(arrays, "arrays/bridge.perNodeIsBridge.u8", ba.perNodeIsBridge),
    };
  }

  // 8. Toy citation pipeline outputs (only present in toy mode).
  if (state.neighbourhoodResult) out.neighbourhoodResult = state.neighbourhoodResult;
  if (state.tasteResult)         out.tasteResult         = state.tasteResult;
  if (state.citationResult)      out.citationResult      = state.citationResult;

  // 9. Citation layout / alignment.
  if (state.citationLayout instanceof Float32Array) {
    out.citationLayout = stashBinary(arrays, "arrays/citationLayout.f32", state.citationLayout);
  }
  if (state.alignedCitationLayout instanceof Float32Array) {
    out.alignedCitationLayout = stashBinary(arrays, "arrays/alignedCitationLayout.f32", state.alignedCitationLayout);
  }
  if (Number.isFinite(state.alignmentCorrelation)) {
    out.alignmentCorrelation = state.alignmentCorrelation;
  }

  // 10. Eval results — JSON-friendly.
  if (state.evalResults) {
    out.evalResults = state.evalResults;
  }

  // 11. Project name (display only — used by Save vs Save-as).
  if (state.projectName) out.projectName = state.projectName;

  // Build the zip.
  const manifest = buildManifest({
    projectName: state.projectName || null,
    contents:    ["manifest.json", "state.json", ...Object.keys(arrays)],
  });
  const stateJson    = JSON.stringify(out, null, 0);     // compact
  const manifestJson = JSON.stringify(manifest, null, 2);

  const zipEntries = {
    "manifest.json": strToU8(manifestJson),
    "state.json":    strToU8(stateJson),
    ...arrays,
  };
  const zipped = zipSync(zipEntries, { level: 6 });
  return new Blob([zipped], { type: "application/zip" });
}

function serialiseClusterResult(cr, arrays, levelIdx) {
  const out = {
    method:         cr.method,
    params:         cr.params,
    clusters:       cr.clusters,
    structureEdges: cr.structureEdges,
  };
  if (cr.nodeCluster instanceof Int32Array) {
    out.nodeCluster = stashBinary(
      arrays,
      `arrays/clusterLevels/${levelIdx}.nodeCluster.i32`,
      cr.nodeCluster,
    );
  }
  if (cr.noiseFlags instanceof Uint8Array) {
    out.noiseFlags = stashBinary(
      arrays,
      `arrays/clusterLevels/${levelIdx}.noiseFlags.u8`,
      cr.noiseFlags,
    );
  }
  return out;
}

// Move a TypedArray into the arrays bag and return a descriptor
// the loader can use to find it. Path becomes a key inside the zip.
function stashBinary(arrays, path, typedArray) {
  // fflate expects Uint8Array per entry — view the same buffer.
  const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
  arrays[path] = bytes;
  return {
    __binary: path,
    type:     typedArray.constructor.name,
    length:   typedArray.length,
  };
}
