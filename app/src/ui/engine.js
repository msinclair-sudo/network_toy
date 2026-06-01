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
import { inferNeighbourhoods, defaultNeighbourhoodParams }       from "../neighbourhoods.js";
import { buildCitationTaste, defaultTasteParams }                from "../citation-taste.js";
import { generateCitations, defaultCitationParams }              from "../citations.js";
import { getAlgorithm as getCitationAlgorithm }                  from "../citations/registry.js";
import { assertCitationResult }                                  from "../citations/contract.js";
import { getAlgorithm as getCitationLayoutAlgorithm }            from "../citation-layout/registry.js";
import { alignByComponent, alignGlobal }                         from "../blend/align.js";
import { computeBridgeAnalysis }                                 from "./bridge-analysis.js";
import { runPhase2Score, buildLayersFromPicks }                 from "../eval/multilayer-sweep.js";
import { update, getState, setLayerState }                       from "./state.js";
import { runDAG }                                                from "../workers/dag.js";
import { slimNodesForClustering }                                from "../clustering-cascade.js";

// Worker URLs resolved relative to this module so the runtime path
// matches the project's served file layout regardless of which page
// hosts engine.js. import.meta.url is the engine module's own URL.
const DIMRED_WORKER_URL     = new URL("../workers/dimred-worker.js",     import.meta.url);
const CLUSTERING_WORKER_URL = new URL("../workers/clustering-worker.js", import.meta.url);
const LAYOUT_WORKER_URL     = new URL("../workers/layout-worker.js",     import.meta.url);

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
// Ingest the data source ONLY — produce the dataset + reset downstream
// slots, WITHOUT cascading into dim-reduction. UI #2's granular build-
// out uses this so "add data source" creates just a data card; the user
// then adds dim-reduction (redimred) + clustering (recluster) via the
// per-card + buttons. reingest() = ingestDataOnly() + redimred() and
// keeps the original full-cascade behaviour for every existing caller.
export async function ingestDataOnly() {
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
}

// Full data cascade: ingest + dim-reduce (which in turn cascades into
// clustering). Unchanged behaviour for all existing callers + tests.
export async function reingest() {
  await ingestDataOnly();
  await redimred();
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
export async function redimred({ cascade = true } = {}) {
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

  // Mark the layer as "running" so the workflow chart's status dot
  // turns orange while the workers crunch. The matching "fresh" set
  // at the end of the lane swaps it back to green. Without this the
  // dot stays green throughout the (potentially 30+ s) compute and
  // there's no visible progress signal outside the modal's Running…
  // button.
  setLayerState("dimred", "running");

  // Snapshot what we need from `s` up front. After the await we'll
  // re-read state for the freshest version of any slot that other
  // lanes might have touched, but the per-lane inputs (genResult
  // identity, this lane's cfg, the seed _basePos) are fixed for this
  // run by the inputs we feed the DAG below.
  const initialBasePos = s._basePos;
  const initialBasePos2d = s._basePos2d;

  const fusionCfg     = cfg.fusion || { method: "identity", params: {} };
  const fusionIsActive = fusionCfg.method !== "identity";

  // ── Compute graph for this lane. ─────────────────────────────────
  //
  //   input0 ──▶ noise ──▶ fusion ─┬──▶ compression  (clustering input)
  //                                ├──▶ viz          (3D viewer basePos)
  //                                └──▶ viz2d        (2D viewer basePos)
  //
  //   when fusion is active, also:
  //                       noise ──┬──▶ compPre       (pre-fusion clustering input)
  //                               └──▶ vizPre        (pre-fusion 3D basePos)
  //
  // Each node fires in its own Worker; siblings (compression / viz /
  // viz2d, plus optional compPre / vizPre) run in parallel via
  // runDAG's batching. Procrustes alignment stays on the main thread
  // (cheap, depends on two viz results being done).
  //
  // Identity stages still go through workers — the dispatch overhead
  // is negligible (<10 ms spawn) compared with even the fastest real
  // algorithm, and uniform routing keeps the lane's control flow
  // simple. If profiling later shows identity hot, short-circuit then.

  const dag = {
    noise: {
      workerUrl: DIMRED_WORKER_URL,
      deps: [],
      buildPayload: () => ({
        algo:   cfg.noise.method,
        input:  input0,
        params: cfg.noise.params || {},
      }),
    },
    fusion: {
      workerUrl: DIMRED_WORKER_URL,
      deps: ["noise"],
      buildPayload: (r) => ({
        algo:   fusionCfg.method,
        input:  { n: r.noise.n, d: r.noise.d, data: r.noise.data },
        // Adjacency is injected at compute() time; the algorithm
        // itself stays pure (no global-state reads inside the worker).
        params: { ...(fusionCfg.params || {}), adjacency: s.rawCitationEdges || [] },
      }),
    },
    compression: {
      workerUrl: DIMRED_WORKER_URL,
      deps: ["fusion"],
      buildPayload: (r) => ({
        algo:   cfg.compression.method,
        input:  { n: r.fusion.n, d: r.fusion.d, data: r.fusion.data },
        params: cfg.compression.params || {},
      }),
    },
    viz: {
      workerUrl: DIMRED_WORKER_URL,
      deps: ["fusion"],
      buildPayload: (r) => ({
        algo:   cfg.viz.method,
        input:  { n: r.fusion.n, d: r.fusion.d, data: r.fusion.data },
        params: cfg.viz.params || {},
      }),
    },
    viz2d: {
      workerUrl: DIMRED_WORKER_URL,
      deps: ["fusion"],
      buildPayload: (r) => ({
        algo:   cfg.viz2d.method,
        input:  { n: r.fusion.n, d: r.fusion.d, data: r.fusion.data },
        params: cfg.viz2d.params || {},
      }),
    },
  };

  if (fusionIsActive) {
    // Pre-fusion sibling pair — same compression + viz algorithms as
    // the post-fusion side, but fed the noise output directly so the
    // fusion-comparison slider has a "before fusion" endpoint.
    dag.compPre = {
      workerUrl: DIMRED_WORKER_URL,
      deps: ["noise"],
      buildPayload: (r) => ({
        algo:   cfg.compression.method,
        input:  { n: r.noise.n, d: r.noise.d, data: r.noise.data },
        params: cfg.compression.params || {},
      }),
    };
    dag.vizPre = {
      workerUrl: DIMRED_WORKER_URL,
      deps: ["noise"],
      buildPayload: (r) => ({
        algo:   cfg.viz.method,
        input:  { n: r.noise.n, d: r.noise.d, data: r.noise.data },
        params: cfg.viz.params || {},
      }),
    };
  }

  // Fire the lane. Any worker rejecting will reject this entire await
  // with the underlying error; callers (modal apply / reingest) catch
  // and report.
  const r = await runDAG(dag);

  // Validate everything that came back. Contract violations surface
  // here rather than silently corrupting downstream state.
  validateDimredResult(r.noise,       n);
  validateDimredResult(r.fusion,      n);
  validateDimredResult(r.compression, n);
  validateDimredResult(r.viz,         n);
  validateDimredResult(r.viz2d,       n);
  if (fusionIsActive) {
    validateDimredResult(r.compPre, n);
    validateDimredResult(r.vizPre,  n);
  }

  // ── Post-fusion viz adoption. Same branching as before — only
  // the source (`r.viz`) changed; the rules for when to adopt and
  // when to fall through to the seed basePos are unchanged.
  let nextBasePos = initialBasePos;     // fall through unless viz produces 3-d
  if (r.viz.d === 3 && r.viz.method !== "identity") {
    nextBasePos = normaliseToViewerScale(r.viz.data);
  } else if (initialBasePos == null && r.viz.d === 3) {
    nextBasePos = r.viz.data;
  }

  // ── Post-fusion viz2d adoption. Same rules as before.
  let nextBasePos2d = initialBasePos2d;
  if (r.viz2d.d === 2 && r.viz2d.method !== "identity") {
    nextBasePos2d = normaliseToViewerScale2d(r.viz2d.data);
  } else if (r.viz2d.d !== 2) {
    if (cfg.viz2d.method === "identity" && r.viz2d.d !== 2) {
      nextBasePos2d = null;
    }
  }

  if (nextBasePos) {
    syncNodeBasePos(s.genResult.nodes, nextBasePos);
  }

  // ── Pre-fusion adoption + Procrustes. Mirrors the post-fusion
  // viz handling above, then aligns the result to nextBasePos so the
  // fusion-comparison slider walks the SHORT geometric path between
  // pre- and post-fusion layouts (UMAP picks an arbitrary rotation
  // per fit; without alignment the lerp spins points through nonsense
  // intermediate frames).
  let preFusionDimred  = null;
  let preFusionBasePos = null;
  if (fusionIsActive) {
    preFusionDimred = r.compPre;

    if (r.vizPre.d === 3 && r.vizPre.method !== "identity") {
      preFusionBasePos = normaliseToViewerScale(r.vizPre.data);
    } else if (initialBasePos == null && r.vizPre.d === 3) {
      preFusionBasePos = r.vizPre.data;
    }

    if (preFusionBasePos && nextBasePos && preFusionBasePos.length === nextBasePos.length) {
      const alignRes = alignGlobal({
        target: nextBasePos,
        source: preFusionBasePos,
        n,
      });
      preFusionBasePos = alignRes.aligned;
    }
  }

  // Re-read state for the freshest engineRevision counter. Other
  // lanes may have written between our snapshot and now (unlikely
  // in the current single-lane-at-a-time call pattern, but cheap
  // insurance).
  const sNow = getState();
  update({
    dimredResult:          r.compression,
    dimredResultPreFusion: preFusionDimred,
    _basePos:              nextBasePos,
    _basePosPreFusion:     preFusionBasePos,
    _basePos2d:            nextBasePos2d,
    engineRevision:        sNow.engineRevision + 1,
  });
  setLayerState("dimred", "fresh");
  // UI #2 granular build-out: the dimred descriptor calls
  // redimred({cascade:false}) so adding a dim-reduction card doesn't
  // auto-run clustering — the user adds clustering via the + button.
  // reingest()/full-pipeline callers keep cascade=true.
  if (cascade) await recluster();
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
export async function recluster(opts = {}) {
  // opts.precomputedCr: { algoId, params, cr } — when present AND the
  //   first level's (algoId, params) matches, the cascade skips L0's
  //   algo.infer and uses cr verbatim. Plumbed in by the Optimise tab's
  //   per-row Apply path so the sweep's already-paid infer doesn't get
  //   redone (A3, §6.18.3). Only L0 is eligible today; deeper levels
  //   are either within-parent (not cacheable) or could be later if a
  //   use case appears.
  const { precomputedCr = null } = opts;

  const s = getState();
  if (!s.genResult) return;
  const algo = activeClusterAlgorithm();
  const cfg = s.layerParams.clustering;
  const allowNoise = !!algo.allowsNoise;
  const n = s.genResult.nodes.length;

  if (!cfg || !cfg.levels || cfg.levels.length === 0) return;

  // Mark the layer "running" so the workflow chart's status dot turns
  // orange while the worker crunches (HDBSCAN at BFS-5000 is ~18 s).
  // The matching "fresh" set at the end swaps it back to green.
  setLayerState("clustering", "running");

  // The clustering algorithms only read .id + .basePos off each node,
  // so we ship a slim view to the worker. Saves ~10× on postMessage
  // copy at real-data scale (genResult.nodes carries embedding,
  // origin, t, cite lists, …).
  const nodesSlim = slimNodesForClustering(s.genResult.nodes);

  // Build the precomputedLevels array (sparse cr cache by level index).
  // Only L0 is currently eligible — and only when the precomputedCr
  // option matches both the algorithm and L0's params verbatim.
  const precomputedLevels = [];
  if (precomputedCr
      && precomputedCr.algoId === algo.id
      && cfg.levels[0]
      && stableParamMatch(cfg.levels[0].params, precomputedCr.params)) {
    precomputedLevels[0] = precomputedCr.cr;
  }

  // ── Compute graph for this lane. ─────────────────────────────────
  //
  //   dimredResult           ──▶ post  (always; produces clusterLevels)
  //   dimredResultPreFusion  ──▶ pre   (only when fusion ran a second
  //                                     pass; produces the pre-fusion
  //                                     levels used by the "Cluster —
  //                                     pre-fusion" colour mode)
  //
  // The two passes are independent (different inputs, same algo /
  // levels) so they run in parallel via runDAG's batching. Each pass
  // is itself sequential internally — its levels chain dependencies
  // (within-parent reads the previous level's clusterResult) — so we
  // send one worker job per pass, not one per level. The worker
  // imports clustering-cascade.js and runs the full chain.
  //
  // precomputedLevels is only sent on the `post` pass — the pre-fusion
  // pass runs on a different dimred input (dimredResultPreFusion) so a
  // cr derived from the post-fusion input would be wrong there.
  const dag = {
    post: {
      workerUrl: CLUSTERING_WORKER_URL,
      deps: [],
      buildPayload: () => ({
        mode:         "cascade",
        algoId:       algo.id,
        nodesSlim,
        dimredResult: s.dimredResult,
        levelCfgs:    cfg.levels,
        allowNoise,
        n,
        precomputedLevels,
      }),
    },
  };
  if (s.dimredResultPreFusion) {
    dag.pre = {
      workerUrl: CLUSTERING_WORKER_URL,
      deps: [],
      buildPayload: () => ({
        mode:         "cascade",
        algoId:       algo.id,
        nodesSlim,
        dimredResult: s.dimredResultPreFusion,
        levelCfgs:    cfg.levels,
        allowNoise,
        n,
      }),
    };
  }

  const r = await runDAG(dag);

  const levels          = r.post;
  const preFusionLevels = r.pre || null;
  const preFusionFinest = preFusionLevels
    ? preFusionLevels[preFusionLevels.length - 1].clusterResult
    : null;

  const finest = levels[levels.length - 1].clusterResult;
  // Derived: bridge analysis pair is taken from state.bridgeConfig
  // (or the deepest valid pair if config is empty/stale). Null when
  // only one level exists. Cheap (single pass over n) — stays on
  // the main thread.
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
    // Optimise tab doesn't show outdated scores. The user can re-run;
    // we'd rather an empty tab body than misleading data. `validate`
    // slot kept on the structure for backward-compat with old saves
    // (§6.18.1 removed the Validate tab; the slot reads as null).
    evalResults: { validate: null, optimise: null },
    // Bump engineRevision so panels rebuild — the colour-by dropdown
    // depends on this signal to refresh its options when cluster
    // levels are added or removed. Without it, adding a second level
    // updates state.clusterLevels but the viewer's option list stays
    // pinned to whatever it had at the last upstream cascade.
    engineRevision: s.engineRevision + 1,
  });
  setLayerState("clustering", "fresh");
  reneighbour();
}

// Multi-level clustering lane (MLC §9). ONE HDBSCAN run in the worker
// extracts a coarse→fine ladder of partitions from the condensed tree
// (the worker's "multilevel" mode). Lands them in state.clusterLevels in
// exactly the same shape recluster() produces, so bridge analysis,
// projection, and the viewer's colour-by-layer mode all work unchanged.
//
// opts: { params?, capLayers?, minClusters?, uidPrefix? }. Returns the
// worker output { layers, levels } (levels empty if the tree was
// structureless) so the runner can snapshot it into the card.
// PRODUCE-ONLY sweep (§9 revamp 2026-06-01). Runs Phase 1 (worker: one
// HDBSCAN model + plateau candidates) + Phase 2 (main: bootstrap-score EVERY
// candidate), and stores the whole scored set on state.multiLevelSweep. It
// does NOT pick layers and does NOT touch clusterLevels — selection is now a
// manual click on the reproducibility curve (the picker card), which calls
// commitMultiLevelLayers() below. The candidates retain their clusterResult
// (nodeCluster), so committing a pick needs no sweep re-run.
//
// Returns { candidates, curve } so the runner can snapshot them into the
// producer card.
export async function recomputeMultiLevelSweep(opts = {}) {
  const s = getState();
  if (!s.genResult || !s.dimredResult) return { candidates: [], curve: [] };
  const n = s.genResult.nodes.length;
  const params = opts.params || { minSamples: 15, selectionMethod: "leaf" };

  setLayerState("clustering", "running");
  const nodesSlim = slimNodesForClustering(s.genResult.nodes);

  // ── Phase 1 (worker): build the model once + plateau candidates. ──
  const dag = {
    ml: {
      workerUrl: CLUSTERING_WORKER_URL,
      deps: [],
      buildPayload: () => ({
        mode:         "multilayer",
        nodesSlim,
        dimredResult: s.dimredResult,
        params,
        n,
        opts: { sizeGridCount: opts.sizeGridCount },
      }),
    },
  };
  const r = await runDAG(dag);
  const phase1 = (r.ml && r.ml.candidates) || [];
  if (phase1.length === 0) {
    setLayerState("clustering", "fresh");
    update({ multiLevelSweep: { candidates: [], curve: [] }, engineRevision: (getState().engineRevision || 0) + 1 });
    return { candidates: [], curve: [] };
  }

  // ── Phase 2 (main thread): bootstrap-score EVERY candidate. The bootstrap
  //    fans its B re-clusterings out across clustering-workers. ──
  const { candidates, curve } = await runPhase2Score({
    candidates:    phase1,
    genResult:     s.genResult,
    dimredResult:  s.dimredResult,
    algo:          getClusteringAlgorithm("hdbscan"),
    params:        { ...params, uidPrefix: opts.uidPrefix },
    bootstrapOpts: opts.bootstrapOpts || {},
    onProgress:    opts.onProgress || null,
    abortSignal:   opts.abortSignal || null,
  });

  update({
    // The whole scored sweep — candidates (with clusterResults) for the
    // picker's commit, curve for the chart. No layers committed yet.
    multiLevelSweep: {
      candidates,
      curve,
      uidPrefix: opts.uidPrefix || "ML",
      floor:     Number.isFinite(opts.floor) ? opts.floor : 0.6,   // guide line on the curve
    },
    engineRevision: (getState().engineRevision || 0) + 1,
  });
  setLayerState("clustering", "fresh");
  return { candidates, curve };
}

// Commit a user-picked set of granularities (by cluster count) into the live
// clusterLevels[] ladder, then recompute the downstream (bridge analysis +
// neighbourhoods). Called by the picker card's Apply. Reads the cached
// candidates off state.multiLevelSweep — no sweep re-run, so re-picking is
// cheap. Returns the built levels (empty if nothing valid was picked).
export function commitMultiLevelLayers(pickedCounts, opts = {}) {
  const s = getState();
  const sweep = s.multiLevelSweep;
  if (!sweep || !Array.isArray(sweep.candidates) || sweep.candidates.length === 0) {
    return { levels: [] };
  }
  const uidPrefix = opts.uidPrefix || sweep.uidPrefix || "ML";
  const levels = buildLayersFromPicks(sweep.candidates, pickedCounts, uidPrefix);
  if (levels.length === 0) {
    // Nothing valid picked — clear the ladder so the viewer reflects the
    // empty selection rather than a stale one.
    update({
      clusterLevels:          null,
      clusterResult:          null,
      clusterLevelsPreFusion: null,
      clusterResultPreFusion: null,
      bridgeAnalysis:         null,
      engineRevision:         (getState().engineRevision || 0) + 1,
    });
    return { levels: [] };
  }

  const finest = levels[levels.length - 1].clusterResult;
  const cfgBridge = clampedBridgeConfig(s.bridgeConfig, levels);
  const bridgeAnalysis = levels.length >= 2 ? computeBridgeAnalysis(levels, cfgBridge) : null;

  update({
    clusterLevels:          levels,
    clusterResult:          finest,
    // multi-level is a single (post-fusion) ladder — no pre-fusion sibling.
    clusterLevelsPreFusion: null,
    clusterResultPreFusion: null,
    bridgeAnalysis,
    bridgeConfig:    cfgBridge,
    evalResults:     { validate: null, optimise: null },
    engineRevision:  (getState().engineRevision || 0) + 1,
  });
  setLayerState("clustering", "fresh");
  reneighbour();
  return { levels };
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

// (Multi-level cascade + within-parent + sliceDimred moved to
// app/src/clustering-cascade.js so the clustering worker can run the
// full pass without re-implementing the same logic.)

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
export async function relayoutCitations() {
  const s = getState();
  if (!s.genResult || !s.citationResult) return;
  const n = s.genResult.nodes.length;
  const t = new Float32Array(n);
  for (let i = 0; i < n; i++) t[i] = s.genResult.nodes[i].t;

  // Mark "running" so the workflow chart's layout / alignment / blend
  // dots reflect the in-flight work. UMAP-on-graph at BFS-5000 is
  // ~5-15 s; without this signal there's no visible progress outside
  // the modal's Running… button. We only mark "layout" running (the
  // worker-bound stage); alignment + blend stay stale until the
  // worker's result lands and we kick off the main-thread alignment.
  setLayerState("layout", "running");

  const layoutAlgo = getCitationLayoutAlgorithm(s.layerParams.layout.method);
  const edges = s.citationResult.citations.map(c => [c.source, c.target]);

  // ── Compute graph for this lane. ─────────────────────────────────
  //
  //   layout (one of FR / MDS / UMAP-on-graph)   ──▶ citationLayout
  //
  // Single-node DAG; no parallelism to exploit (alignment depends on
  // basePos, which lives in state, and stays on the main thread).
  // We route through runDAG anyway for uniformity with redimred /
  // recluster — same shape across all three heavy lanes makes future
  // additions (progress reporting, centralised cancellation) cheap.
  const dag = {
    layout: {
      workerUrl: LAYOUT_WORKER_URL,
      deps: [],
      buildPayload: () => ({
        algoId:  s.layerParams.layout.method,
        payload: {
          n, edges, t,
          seed:   s.layerParams.citations.samplingSeed,
          params: s.layerParams.layout.params,
        },
      }),
    },
  };

  const r = await runDAG(dag);
  const citationLayout = r.layout;

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

// Stable comparison of two algorithm-param objects. Used by recluster()
// to decide whether a precomputedCr is safe to substitute for L0's
// algo.infer. Sorted-key JSON keeps the order-of-insertion difference
// from causing spurious mismatches when one side was hand-built and the
// other came back from the worker.
function stableParamMatch(a, b) {
  if (!a || !b) return false;
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (a[ka[i]] !== b[kb[i]]) return false;
  }
  return true;
}
