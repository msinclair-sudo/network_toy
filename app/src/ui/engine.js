// Engine orchestrator for the new shell.
//
// Mirrors the legacy main.js pipeline (regenerate → recluster →
// reneighbour → retaste → resample → relayoutCitations) but
// writes results into the new state container instead of a local
// closure. Modules from app/src/ (generation, clustering*, citations*,
// blend/align, citation-layout/) are unchanged — this is just the
// new glue layer.
//
// Each public function below = one re-run lane. Downstream functions
// are called automatically so a parameter change at any layer
// cascades to the layout + alignment without redoing upstream work.

import { getDataSource, listDataSources }                       from "../datasource/registry.js";
import { validateDataSourceResult }                              from "../datasource/contract.js";
import { getAlgorithm as getDimredAlgorithm,
         listAlgorithms as listDimredAlgorithms }                from "../dimred/registry.js";
import { validateDimredResult }                                  from "../dimred/contract.js";
import { getAlgorithm as getClusteringAlgorithm,
         listAlgorithms as listClusteringAlgorithms }            from "../clustering-registry.js";
import { validateClusterResult }                                 from "../contracts/cluster.js";
import { inferNeighbourhoods, defaultNeighbourhoodParams }       from "../neighbourhoods.js";
import { buildCitationTaste, defaultTasteParams }                from "../citation-taste.js";
import { generateCitations, defaultCitationParams }              from "../citations.js";
import { getAlgorithm as getCitationAlgorithm }                  from "../citations/registry.js";
import { assertCitationResult }                                  from "../citations/contract.js";
import { getAlgorithm as getCitationLayoutAlgorithm }            from "../citation-layout/registry.js";
import { alignByComponent, alignGlobal }                         from "../blend/align.js";
import { computeBridgeAnalysis }                                 from "./bridge-analysis.js";
import { update, getState, setLayerState }                       from "./state.js";

// Initialise layerParams from registry defaults on first call.
function ensureLayerParams() {
  const s = getState();
  const lp = s.layerParams;
  let dirty = false;
  const next = { ...lp };

  if (!lp.dimred) {
    // Five-stage shape:
    //   noise         (PCA denoiser; consumed by all downstream stages)
    //   fusion        (citation-aware re-embedding; consumes noise output + raw citation edges)
    //   compression   (UMAP-50; produces the clustering input)
    //   viz           (UMAP-3; produces the 3D viewer / blend input — basePos)
    //   viz2d         (UMAP-2; produces the 2D viewer input — _basePos2d)
    // Defaults are identity everywhere, so dimredResult is just the
    // input embedding (or basePos in toy mode) and behaviour is
    // unchanged until the user picks a real algorithm in any slot.
    // Fusion stays at identity until rawCitationEdges is populated;
    // an explicit `graph-diffusion` pick is required to opt in.
    const idAlgo = getDimredAlgorithm("identity");
    next.dimred = {
      noise:       { method: "identity", params: idAlgo.defaultParams() },
      fusion:      { method: "identity", params: idAlgo.defaultParams() },
      compression: { method: "identity", params: idAlgo.defaultParams() },
      viz:         { method: "identity", params: idAlgo.defaultParams() },
      viz2d:       { method: "identity", params: idAlgo.defaultParams() },
    };
    dirty = true;
  } else if (!lp.dimred.fusion) {
    // Backwards-compat for older save files / state restored from
    // pre-fusion archives: synthesise an identity fusion slot in-place
    // so redimred() doesn't trip on an undefined section. No schema
    // bump — old data flows through unchanged.
    const idAlgo = getDimredAlgorithm("identity");
    next.dimred = {
      ...lp.dimred,
      fusion: { method: "identity", params: idAlgo.defaultParams() },
    };
    dirty = true;
  }
  if (!lp.neighbourhood) { next.neighbourhood = defaultNeighbourhoodParams(); dirty = true; }
  if (!lp.taste)         { next.taste         = defaultTasteParams();         dirty = true; }
  if (!lp.citations) {
    // Citation params are a flat bag (density / intraRate / …) for
    // historical reasons + a `method` slot naming which algorithm in
    // the citations registry to run. Method defaults to taste-network
    // (the only generator we had until imported-edges landed); the
    // data-source switch in reingest() overrides per source.
    next.citations = { method: "taste-network", ...defaultCitationParams() };
    dirty = true;
  } else if (!lp.citations.method) {
    next.citations = { ...lp.citations, method: "taste-network" };
    dirty = true;
  }
  if (!lp.clustering) {
    // Multi-level clustering: each level holds its own params and a
    // scope flag ("global" = re-cluster the whole dataset; "within-
    // parent" = cluster within each previous-level cluster's members).
    // Default is one global level with the algorithm's defaults — same
    // observable behaviour as before. Sub-clustering is opt-in via the
    // modal's + Add level.
    const algoId = "mutualKNN";
    const algo = getClusteringAlgorithm(algoId);
    next.clustering = {
      method: algoId,
      levels: [
        { uid: makeUid(), params: algo.defaultParams(), scope: "global" },
      ],
    };
    dirty = true;
  }
  if (!lp.layout) {
    next.layout = { method: "fruchterman-reingold", params: {} };
    dirty = true;
  }

  if (dirty) update({ layerParams: next });
}

function activeClusterAlgorithm() {
  const s = getState();
  return getClusteringAlgorithm(s.layerParams.clustering.method);
}

function activeCitationAlgorithm() {
  const s = getState();
  const id = (s.layerParams.citations && s.layerParams.citations.method) || "taste-network";
  return getCitationAlgorithm(id);
}

// Legacy summary (single label) — kept for the workflow-chart consumer
// that still asks for the active dim-reduction "method". Returns the
// compression-stage method when it's a real reduction, else falls back
// to noise-stage method, else identity.
function activeDimredSummaryMethod() {
  const s = getState();
  const lp = s.layerParams.dimred || {};
  const compMethod  = lp.compression && lp.compression.method;
  const noiseMethod = lp.noise       && lp.noise.method;
  if (compMethod  && compMethod  !== "identity") return compMethod;
  if (noiseMethod && noiseMethod !== "identity") return noiseMethod;
  return "identity";
}

function makeUid() {
  return Math.random().toString(36).slice(2, 10);
}

/* ── public API: pipeline lanes ─────────────────────────────────────── */

// Full re-run from Layer 1 down. Dispatches through the data-source
// registry, then cascades into the dim-reduction → clustering → ...
// chain. Async because the real source fetches over the network;
// callers fire-and-forget (no caller currently awaits).
//
// On a mode switch, every downstream output (clusterLevels, citations,
// layout, alignment, embedding, dimredResult) is wiped — the toy and
// real datasets are mutually exclusive, never co-resident.
export async function reingest() {
  ensureLayerParams();
  const s = getState();

  const sourceId = s.activeAlgorithm.dataSource || "toy";
  const source   = getDataSource(sourceId);
  const config   = (s.dataSource.configs && s.dataSource.configs[sourceId]) || source.defaultParams();

  // Pick the citation algorithm appropriate for this source. Toy
  // generates synthetic citations via taste-network; real loads them
  // from disk via imported-edges. User can still flip the method
  // afterward; this is just the sensible default at switch-time.
  // Same lane also plumbs the toy's citation knobs (density / intra /
  // cross) into Layer 3 params — they live under dataSource.configs.toy
  // by historical convention (the data panel owns them UX-wise even
  // though they're algorithmically Layer 3).
  {
    const cur = getState();
    const desiredMethod = sourceId === "toy" ? "taste-network" : "imported-edges";
    const nextCitations = { ...cur.layerParams.citations, method: desiredMethod };
    if (sourceId === "toy") {
      nextCitations.density   = config.density;
      nextCitations.intraRate = config.intraRate;
      nextCitations.crossRate = config.crossRate;
    }
    update({
      layerParams: {
        ...cur.layerParams,
        citations: nextCitations,
      },
    });
  }

  const result = await source.produce(config);
  validateDataSourceResult(result);

  const n = result.nodes.length;

  // Pack basePos into the flat Float32Array(n × 3) the blend hook +
  // alignment pass consume. Three input shapes:
  //   1. nodes carry per-node basePos    → toy's natural shape
  //   2. result.basePos is a flat buffer → uncommon, supported for symmetry
  //   3. neither                          → real-data path; viz sub-stage
  //                                         will populate _basePos later
  let bp = null;
  if (result.basePos instanceof Float32Array && result.basePos.length === n * 3) {
    bp = result.basePos;
  } else if (result.nodes.every(node => Array.isArray(node.basePos) && node.basePos.length === 3)) {
    bp = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = result.nodes[i].basePos;
      bp[i*3] = p[0]; bp[i*3+1] = p[1]; bp[i*3+2] = p[2];
    }
  }

  // Wipe every downstream artifact — they're indexed by node.id from
  // the previous source and would crash anything that re-reads them.
  // Bump engineRevision so panels rebuild even if downstream lanes
  // bail (e.g. real-data has no basePos → citation chain skips →
  // relayoutCitations never runs to trigger the conventional bump).
  // Cache raw citation edges from the data source if it supplied them
  // (today: real-data via produceReal()). Flat number[] of length 2|E|
  // in [src, dst, …] form, read by the fusion stage and Layer 3's
  // imported-edges algorithm. Toy returns no edges → null cleared.
  const rawCitationEdges = Array.isArray(result.citationEdges)
    ? result.citationEdges
    : null;

  update({
    genResult:              result,
    _basePos:               bp,
    _basePos2d:             null,
    _basePosPreFusion:      null,
    embedding:              result.embedding || null,
    rawCitationEdges,
    dimredResult:           null,
    dimredResultPreFusion:  null,
    clusterLevels:          null,
    clusterLevelsPreFusion: null,
    clusterResult:          null,
    clusterResultPreFusion: null,
    bridgeAnalysis:         null,
    neighbourhoodResult:    null,
    tasteResult:            null,
    citationResult:         null,
    citationLayout:         null,
    alignedCitationLayout:  null,
    alignmentCorrelation:   NaN,
    engineRevision:         s.engineRevision + 1,
  });
  setLayerState("data", "fresh");
  redimred();
}

// Backward-compat alias — old call sites + the legacy shell still
// say `regenerate`. New code should use reingest().
export const regenerate = reingest;

// Layer 1.5 — dim-reduction. Four stages:
//
//   noise         (e.g. PCA denoiser; consumed by every downstream stage)
//   compression   (e.g. UMAP-50; produces state.dimredResult — clustering input)
//   viz           (e.g. UMAP-3;  produces state._basePos      — 3D viewer input)
//   viz2d         (e.g. UMAP-2;  produces state._basePos2d    — 2D viewer input)
//
// compression, viz, and viz2d are siblings — all three read the noise
// stage's output. Each stage's output is validated against the dimred
// contract.
//
// Stage input shape:
//   * If state.embedding is present (real data), noise reads it.
//   * Else, basePos is packed into a DimredInput (toy data — basePos
//     doubles as the embedding).
//
// _basePos handling:
//   * Toy: data source supplied basePos directly; viz stage runs but
//     is identity by default → _basePos stays as packed by reingest.
//   * Real: data source had no basePos; viz stage's output becomes
//     _basePos *only* when it produces a 3-d result. Identity (toy
//     default) on 768-d input would yield 768-d, which can't render —
//     so we leave _basePos null. User has to pick a 3-d viz reduction
//     (e.g. UMAP-3) to populate the viewer.
export function redimred() {
  const s = getState();
  if (!s.genResult) return;
  const cfg = s.layerParams.dimred;
  if (!cfg) return;
  const n = s.genResult.nodes.length;

  // Stage 0 input: prefer real embedding, fall back to packing basePos.
  const input0 = pickStage0Input(s);
  if (!input0) {
    // No embedding and no basePos — nothing to reduce. Leave dimredResult
    // null and stop the cascade.
    update({ dimredResult: null });
    setLayerState("dimred", "fresh");
    return;
  }

  // Stage 1: noise reduction.
  const noiseAlgo = getDimredAlgorithm(cfg.noise.method);
  const r1 = noiseAlgo.compute(input0, cfg.noise.params || {});
  validateDimredResult(r1, n);
  const noiseOut = { n: r1.n, d: r1.d, data: r1.data };

  // Stage 1.5: citation-aware fusion. Lateral stage — same
  // dimensionality in as out. Reads raw citation edges out of
  // state.rawCitationEdges (populated by produceReal at ingest
  // time). Adjacency is injected at compute() time as a flat
  // [src, dst, …] number[]; the algorithm itself stays pure
  // (no global-state reads). When fusion=identity OR there are
  // no edges (toy mode), this is a no-op pass-through.
  const fusionCfg  = cfg.fusion || { method: "identity", params: {} };
  const fusionAlgo = getDimredAlgorithm(fusionCfg.method);
  const fusionParams = {
    ...(fusionCfg.params || {}),
    adjacency: s.rawCitationEdges || [],
  };
  const rFusion = fusionAlgo.compute(noiseOut, fusionParams);
  validateDimredResult(rFusion, n);
  // Downstream siblings (compression / viz / viz2d) read from fusion
  // output, not noise output — so any non-identity fusion algorithm
  // propagates into clustering, basePos, and the 2D viewer alike.
  const fusionOut = { n: rFusion.n, d: rFusion.d, data: rFusion.data };

  // Stage 2a: dimension compression (clustering input).
  const compAlgo = getDimredAlgorithm(cfg.compression.method);
  const r2 = compAlgo.compute(fusionOut, cfg.compression.params || {});
  validateDimredResult(r2, n);

  // Stage 2b: visualisation reduction (viewer / blend input).
  // Skipped if the data source already supplied a 3-d basePos and the
  // user hasn't opted into a real viz algorithm — in that case the
  // viz default is identity, and identity-on-basePos returns the
  // same buffer the data source gave us. Either way: viz runs, and if
  // its output is 3-d we adopt it as _basePos; otherwise we leave
  // _basePos as whatever reingest already packed (or null).
  const vizAlgo = getDimredAlgorithm(cfg.viz.method);
  const r3 = vizAlgo.compute(fusionOut, cfg.viz.params || {});
  validateDimredResult(r3, n);

  let nextBasePos = s._basePos;     // fall through unchanged unless viz produces 3-d
  if (r3.d === 3 && r3.method !== "identity") {
    // Normalise UMAP-3 (or any other viz reduction) output to the
    // viewer's canonical scale. UMAP outputs in ~[-3, 3]; the toy
    // generator's basePos lives in ~[-60, 60]. Without scaling, real
    // data shows as a tiny blob at the centre.
    nextBasePos = normaliseToViewerScale(r3.data);
  } else if (s._basePos == null && r3.d === 3) {
    // Edge case: data source had no basePos AND viz happened to be
    // identity-on-3-d-input — adopt it (no normalisation, since
    // identity preserves the data source's intended scale).
    nextBasePos = r3.data;
  }

  // Stage 2c: 2-d visualisation reduction (2D viewer input).
  // Mirrors the viz handling above but only adopts when output is 2-d.
  // _basePos2d stays null until the user picks a 2-d-producing algo
  // (UMAP-2, PCA-2) — the 2D viewer panel surfaces an empty-state
  // hint in that case.
  const viz2dAlgo = getDimredAlgorithm(cfg.viz2d.method);
  const r4 = viz2dAlgo.compute(fusionOut, cfg.viz2d.params || {});
  validateDimredResult(r4, n);

  let nextBasePos2d = s._basePos2d;
  if (r4.d === 2 && r4.method !== "identity") {
    nextBasePos2d = normaliseToViewerScale2d(r4.data);
  } else if (r4.d !== 2) {
    // Output isn't 2-d (identity-on-3-d, identity-on-768-d, etc.).
    // Leave _basePos2d as-is — keeps a previously-good value alive
    // if the user is just re-running clustering, or null if there
    // wasn't one. Either way: 2D viewer's render gate is honest.
    if (cfg.viz2d.method === "identity" && r4.d !== 2) {
      nextBasePos2d = null;
    }
  }

  // Keep nodes[i].basePos in sync with the canonical _basePos buffer.
  // Several existing consumers (clustering centre/spread output,
  // neighbourhoods, base-edges) read the per-node form. Real data
  // arrives without per-node basePos; once viz produces it we
  // backfill so those consumers keep working without refactoring.
  if (nextBasePos) {
    syncNodeBasePos(s.genResult.nodes, nextBasePos);
  }

  // ── Pre-fusion A/B path. ──────────────────────────────────────────
  // When fusion is non-identity and produced a different output, run
  // compression + viz on the *pre-fusion* (noise-stage) data too so
  // the fusion-comparison slider has a "before fusion" endpoint, and
  // the cluster lane can produce parallel pre-fusion labels for the
  // "Color by pre-fusion clusters" mode.
  //
  // Skipped when fusion is identity (rFusion.data === noiseOut.data
  // would still pass the check below trivially via the same algorithm;
  // identity is the explicit signal).
  let preFusionDimred  = null;
  let preFusionBasePos = null;
  const fusionIsActive = fusionCfg.method !== "identity";
  if (fusionIsActive) {
    // Compression on noise (pre-fusion). Different from r2 because r2's
    // input was fusionOut.
    const r2Pre = compAlgo.compute(noiseOut, cfg.compression.params || {});
    validateDimredResult(r2Pre, n);
    preFusionDimred = r2Pre;

    // viz on noise (pre-fusion). Mirror the post-fusion viz branching
    // so 3D-output adoption + scale-normalisation behaviour matches.
    const r3Pre = vizAlgo.compute(noiseOut, cfg.viz.params || {});
    validateDimredResult(r3Pre, n);
    if (r3Pre.d === 3 && r3Pre.method !== "identity") {
      preFusionBasePos = normaliseToViewerScale(r3Pre.data);
    } else if (s._basePos == null && r3Pre.d === 3) {
      preFusionBasePos = r3Pre.data;
    } else {
      preFusionBasePos = null;
    }

    // Procrustes-align pre-fusion → post-fusion so the fusion-slider's
    // linear interpolation walks the SHORT route between layouts. UMAP
    // picks an arbitrary rotation each fit, so two runs of UMAP-3 on
    // near-identical inputs produce near-identical topologies under a
    // different orientation; without alignment the slider points spin
    // through nonsense intermediate paths. Whole-graph Procrustes
    // (rotation + reflection + match-RMS scale + translation) leaves
    // the topology untouched while bringing the orientations into
    // register. Skipped when nextBasePos is null (no anchor to align
    // against) — preFusionBasePos stays in its own raw frame.
    if (preFusionBasePos && nextBasePos && preFusionBasePos.length === nextBasePos.length) {
      const alignRes = alignGlobal({
        target: nextBasePos,
        source: preFusionBasePos,
        n,
      });
      preFusionBasePos = alignRes.aligned;
    }
  }

  update({
    dimredResult:          r2,
    dimredResultPreFusion: preFusionDimred,
    _basePos:              nextBasePos,
    _basePosPreFusion:     preFusionBasePos,
    _basePos2d:            nextBasePos2d,
    engineRevision:        s.engineRevision + 1,
  });
  setLayerState("dimred", "fresh");
  recluster();
}

// 2-d analogue of normaliseToViewerScale. Same centre + isotropic
// scale logic but in 2 dimensions; target RMS half that of the 3D
// viewer since a 2-d plane shows the same data more compactly.
function normaliseToViewerScale2d(data) {
  const n = data.length / 2;
  if (n === 0) return data;
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += data[i*2]; my += data[i*2+1]; }
  mx /= n; my /= n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const dx = data[i*2]   - mx;
    const dy = data[i*2+1] - my;
    sumSq += dx*dx + dy*dy;
  }
  const rms = Math.sqrt(sumSq / n);
  if (rms < 1e-9) return data;
  const TARGET_RMS_2D = 90;       // same scale as VIEWER_TARGET_RMS — force-graph
                                  // auto-fits the camera so absolute scale matters
                                  // less than internal consistency.
  const scale = TARGET_RMS_2D / rms;
  const out = new Float32Array(data.length);
  for (let i = 0; i < n; i++) {
    out[i*2]   = (data[i*2]   - mx) * scale;
    out[i*2+1] = (data[i*2+1] - my) * scale;
  }
  return out;
}

function syncNodeBasePos(nodes, basePos) {
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].basePos = [basePos[i*3], basePos[i*3+1], basePos[i*3+2]];
  }
}

// Centre + isotropic scale so the viewer reads the same regardless of
// who produced basePos. UMAP outputs in ~[-3, 3]; toy generator's
// basePos lives in ~[-60, 60]. Target RMS distance from centre is
// 90 — gives real-data clusters enough room that near-stacked nodes
// separate visually without distorting the topology (this is a pure
// scalar multiply, so cluster IDs / edges / relative geometry are
// untouched).
const VIEWER_TARGET_RMS = 90;
function normaliseToViewerScale(data) {
  const n = data.length / 3;
  if (n === 0) return data;
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) {
    mx += data[i*3]; my += data[i*3+1]; mz += data[i*3+2];
  }
  mx /= n; my /= n; mz /= n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const dx = data[i*3]   - mx;
    const dy = data[i*3+1] - my;
    const dz = data[i*3+2] - mz;
    sumSq += dx*dx + dy*dy + dz*dz;
  }
  const rms = Math.sqrt(sumSq / n);
  // Degenerate case: every point at the same place — return as-is so
  // we don't divide by zero.
  if (rms < 1e-9) return data;
  const scale = VIEWER_TARGET_RMS / rms;
  const out = new Float32Array(data.length);
  for (let i = 0; i < n; i++) {
    out[i*3]   = (data[i*3]   - mx) * scale;
    out[i*3+1] = (data[i*3+1] - my) * scale;
    out[i*3+2] = (data[i*3+2] - mz) * scale;
  }
  return out;
}

// Pick what feeds Layer 1.5's first stage:
//   1. state.embedding   (real-data path; high-dim feature vectors)
//   2. _basePos          (toy path; basePos doubles as embedding)
// Returns null when neither is present (degenerate state).
function pickStage0Input(s) {
  if (s.embedding && s.embedding.data instanceof Float32Array) {
    return { n: s.genResult.nodes.length, d: s.embedding.d, data: s.embedding.data };
  }
  if (s._basePos instanceof Float32Array) {
    return { n: s.genResult.nodes.length, d: 3, data: s._basePos };
  }
  return null;
}

// Layer 2 — multi-level.
// For each level: scope === "global" runs the algorithm on the whole
// dataset; scope === "within-parent" runs it once per parent cluster's
// member set and stitches the results into a globally-numbered
// ClusterResult. The first level is always treated as global (it has
// no parent). Backward-compat: state.clusterResult is set to the
// finest (last) level's ClusterResult so panels not yet level-aware
// keep working.
export function recluster() {
  const s = getState();
  if (!s.genResult) return;
  const algo = activeClusterAlgorithm();
  const cfg = s.layerParams.clustering;
  const allowNoise = !!algo.allowsNoise;
  const n = s.genResult.nodes.length;

  if (!cfg || !cfg.levels || cfg.levels.length === 0) return;

  const levels = runClusterLevels(algo, s.genResult, cfg.levels, s.dimredResult, allowNoise, n);

  // Pre-fusion parallel pass — runs only when fusion produced a
  // separate pre-fusion dimredResult. Same algorithm, same level
  // config, different input → A/B comparison labels for the colour
  // modes. Cheap-ish (clustering is much faster than dim-red).
  let preFusionLevels = null;
  let preFusionFinest = null;
  if (s.dimredResultPreFusion) {
    preFusionLevels = runClusterLevels(algo, s.genResult, cfg.levels, s.dimredResultPreFusion, allowNoise, n);
    preFusionFinest = preFusionLevels[preFusionLevels.length - 1].clusterResult;
  }

  const finest = levels[levels.length - 1].clusterResult;
  // Derived: bridge analysis pair is taken from state.bridgeConfig
  // (or the deepest valid pair if config is empty/stale). Null when
  // only one level exists.
  const cfgBridge = clampedBridgeConfig(s.bridgeConfig, levels);
  const bridgeAnalysis = computeBridgeAnalysis(levels, cfgBridge);

  update({
    clusterLevels:          levels,
    clusterResult:          finest,
    clusterLevelsPreFusion: preFusionLevels,
    clusterResultPreFusion: preFusionFinest,
    bridgeAnalysis,
    bridgeConfig: cfgBridge,
    // Stale eval results → previous clustering. Drop them so the
    // Validate / Optimise tabs don't show outdated scores. The user
    // can re-run; we'd rather an empty tab body than misleading data.
    evalResults: { validate: null, optimise: null },
  });
  setLayerState("clustering", "fresh");
  reneighbour();
}

// Shared multi-level cluster pass — factored out so recluster() can
// invoke it twice (once on the current dimredResult, once on the
// pre-fusion result for A/B comparison). Pure: doesn't read or write
// state, just folds inputs into a levels[] array shaped like the
// existing clusterLevels output.
function runClusterLevels(algo, genResult, levelCfgs, dimredResult, allowNoise, n) {
  const levels = [];
  let parent = null;
  for (let i = 0; i < levelCfgs.length; i++) {
    const lvl = levelCfgs[i];
    const isGlobal = (i === 0) || lvl.scope === "global";
    let cr;
    if (isGlobal) {
      cr = algo.infer(genResult, lvl.params, dimredResult);
    } else {
      cr = clusterWithinParents(algo, genResult, parent, lvl.params, dimredResult);
    }
    validateClusterResult(cr, n, { allowNoise });
    levels.push({ uid: lvl.uid, scope: isGlobal ? "global" : "within-parent", clusterResult: cr });
    parent = cr;
  }
  return levels;
}

// Re-run only the bridge analysis lane — used when the user changes
// the (fineLevel, coarseLevel) pair via the bridge-table panel without
// touching upstream clustering. Cheap (single pass over n).
export function recomputeBridgeAnalysis() {
  const s = getState();
  if (!s.clusterLevels || s.clusterLevels.length < 2) return;
  const cfg = clampedBridgeConfig(s.bridgeConfig, s.clusterLevels);
  const ba  = computeBridgeAnalysis(s.clusterLevels, cfg);
  update({
    bridgeAnalysis: ba,
    bridgeConfig:   cfg,
    engineRevision: s.engineRevision + 1,
  });
}

// Clamp bridgeConfig fields against the actual level count. Empty /
// out-of-range values fall back to the deepest valid pair.
function clampedBridgeConfig(cfg, levels) {
  if (!levels || levels.length < 2) return { fineLevel: null, coarseLevel: null };
  const lastIdx = levels.length - 1;
  let fine = Number.isInteger(cfg && cfg.fineLevel) ? cfg.fineLevel : lastIdx;
  if (fine < 1 || fine > lastIdx) fine = lastIdx;
  let coarse = Number.isInteger(cfg && cfg.coarseLevel) ? cfg.coarseLevel : fine - 1;
  if (coarse < 0 || coarse >= fine) coarse = fine - 1;
  return { fineLevel: fine, coarseLevel: coarse };
}

// Run the clustering algorithm separately on each parent cluster's
// member set, then stitch into a single ClusterResult with global
// IDs. Output cluster IDs are renumbered per parent so they're
// contiguous and non-overlapping. Singletons or empty parents become
// trivial single-cluster outputs.
function clusterWithinParents(algo, genResult, parent, params, dimredResult) {
  const n = genResult.nodes.length;
  const numParents = parent.clusters.length;
  const nodeCluster = new Int32Array(n);
  const clusters = [];
  const structureEdges = [];
  let nextId = 0;

  // Group nodes by parent cluster id.
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

    // Build a sub-genResult that the algorithm can consume directly.
    // Local node ids are 0..ids.length-1; we map back to original ids
    // when writing into the global outputs.
    const subNodes = ids.map((origId, localIdx) => {
      const orig = genResult.nodes[origId];
      return { ...orig, id: localIdx };
    });
    // Sub-dimredResult: copy out the rows for this parent's members so
    // distance computations stay in the same dim-reduced space.
    const subDimred = sliceDimred(dimredResult, ids);
    const subResult = algo.infer({ ...genResult, nodes: subNodes }, params, subDimred);

    for (let localIdx = 0; localIdx < ids.length; localIdx++) {
      const subCid = subResult.nodeCluster[localIdx];
      // subCid may be -1 for noise on noise-aware algos; map preserved.
      nodeCluster[ids[localIdx]] = subCid >= 0 ? nextId + subCid : -1;
    }
    for (const sc of subResult.clusters) {
      if (sc.id < 0) continue;   // noise pseudo-cluster (rare — re-emerge below)
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

// Build a sub-DimredResult that holds only the rows in `ids`, in the
// same order. Used by clusterWithinParents so a within-parent run sees
// a flat positions buffer matching its sub-genResult's local node ids.
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

// Entry to the Layer 3 lane after clustering. Dispatches on the
// active citation algorithm's declared requirements:
//   needsNeighbourhoods === false  → algorithm imports its own
//                                     edges; skip directly to the
//                                     resampleViaImport() lane.
//   needsBasePos        === true   → algorithm needs a 3-d basePos
//                                     (taste-network's Euclidean
//                                     neighbourhood reasoning). Bail
//                                     when basePos isn't materialised
//                                     yet (real-data path before the
//                                     viz sub-stage runs).
// This replaces the previous `if (!_basePos) bail` hack with
// declarative per-algorithm flags read off the registry entry.
export function reneighbour() {
  const s = getState();
  if (!s.genResult || !s.clusterResult) return;

  const citAlgo = activeCitationAlgorithm();

  // Import-style algorithms: short-circuit straight to a dedicated
  // lane that calls the algorithm's async `infer` directly. The
  // neighbourhood / taste lanes never run.
  if (!citAlgo.needsNeighbourhoods) {
    update({ neighbourhoodResult: null, tasteResult: null });
    resampleViaImport();
    return;
  }

  // Generation-style algorithms (taste-network): require basePos.
  if (citAlgo.needsBasePos && !s._basePos) {
    update({ neighbourhoodResult: null });
    return;
  }
  const neighbourhoodResult = inferNeighbourhoods(
    s.genResult, s.clusterResult, s.layerParams.neighbourhood,
  );
  update({ neighbourhoodResult });
  retaste();
}

// Layer 3 — import path. The algorithm's `infer` is async (importers
// do I/O); we await it and then drop into the standard layout lane.
// Fire-and-forget from the caller's perspective; failures show up as
// a null citationResult and a console error so the user can see why
// the cascade stalled (typically: edges file not carved yet).
export async function resampleViaImport() {
  const s = getState();
  const citAlgo = activeCitationAlgorithm();
  const dsId = s.activeAlgorithm.dataSource || "toy";
  const dataSourceParams = (s.dataSource.configs && s.dataSource.configs[dsId]) || {};

  let citationResult;
  try {
    citationResult = await citAlgo.infer(
      s.genResult,
      s.clusterResult,
      s.layerParams.citations,
      dataSourceParams,
    );
  } catch (err) {
    console.error(`[engine] citation import failed:`, err);
    update({ citationResult: null });
    setLayerState("citations", "stale");
    return;
  }
  // Contract check — surfaces shape drift immediately rather than
  // three layers downstream.
  assertCitationResult(citationResult, s.genResult.nodes.length);

  update({ citationResult });
  setLayerState("citations", "fresh");
  // Citation layout is opt-in: the user explicitly applies a layout
  // algorithm via the Citation Layout modal. Cascade STOPS here.
  // Downstream lanes are marked stale until the user triggers them.
  markCitationLayoutStale();
}

// taste-network's internal stages 2 + 3.
export function retaste() {
  const s = getState();
  if (!s.clusterResult || !s.neighbourhoodResult) return;
  const tasteResult = buildCitationTaste(
    s.clusterResult, s.neighbourhoodResult, s.layerParams.taste,
  );
  update({ tasteResult });
  resample();
}

// Layer 3 final stage + cascade.
export function resample() {
  const s = getState();
  if (!s.genResult || !s.clusterResult || !s.neighbourhoodResult || !s.tasteResult) return;
  const citationResult = generateCitations(
    s.genResult, s.clusterResult, s.neighbourhoodResult, s.tasteResult, s.layerParams.citations,
  );
  update({ citationResult });
  setLayerState("citations", "fresh");
  // Citation layout opt-in: see resampleViaImport — same rule.
  markCitationLayoutStale();
}

// Mark layout / alignment / blend as stale and CLEAR cached layouts
// so the existing-stale-blend doesn't keep rendering against a
// citation-result that no longer matches it. Called from both the
// import path (resampleViaImport) and the generation path (resample)
// when citations change. Until the user explicitly applies a layout
// algorithm, citationLayout / alignedCitationLayout stay null and
// the per-frame blend hook falls back to basePos only (α=1 visually
// snaps to basePos because alignedCitationPos is null → blend bails).
function markCitationLayoutStale() {
  update({
    citationLayout:        null,
    alignedCitationLayout: null,
    alignmentCorrelation:  NaN,
  });
  setLayerState("layout",    "stale");
  setLayerState("alignment", "stale");
  setLayerState("blend",     "stale");
}

// Layers 4 + 5a.
export function relayoutCitations() {
  const s = getState();
  if (!s.genResult || !s.citationResult) return;
  const n = s.genResult.nodes.length;
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = s.genResult.nodes[i].t;

  const layoutAlgo = getCitationLayoutAlgorithm(s.layerParams.layout.method);
  const edges = s.citationResult.citations.map(c => [c.source, c.target]);
  const citationLayout = layoutAlgo.compute({
    n, edges, t,
    seed:   s.layerParams.citations.samplingSeed,
    params: s.layerParams.layout.params,
  });

  // Alignment requires a basePos to align *to*. Real-data mode has
  // no basePos until the user picks a 3-d viz reduction; in that case
  // we still publish the raw citationLayout (the 2D viewer can use it
  // as-is for force-graph rendering) but skip alignment + blend, so
  // the slider stays inert until the viewer is populated.
  if (!s._basePos) {
    update({
      citationLayout,
      alignedCitationLayout: null,
      alignmentCorrelation:  NaN,
      engineRevision:        getState().engineRevision + 1,
    });
    setLayerState("layout", "fresh");
    setLayerState("alignment", "stale");
    setLayerState("blend", "stale");
    return;
  }

  const alignResult = alignByComponent({
    basePos:     s._basePos,
    citationPos: citationLayout,
    edges,
    n,
  });

  update({
    citationLayout,
    alignedCitationLayout: alignResult.aligned,
    alignmentCorrelation:  alignResult.correlation,
    engineRevision:        getState().engineRevision + 1,
  });
  setLayerState("layout", "fresh");
  setLayerState("alignment", "fresh");
  setLayerState("blend", "fresh");
}
