// Boot + UI glue.
//
// Production shell: topbar (File, Citations, Debug, Settings, Generate, seed),
// left panel (cluster + citation top-level levers), canvas, right panel
// (cluster legend), bottom bar (edge / node display).
//
// Layered pipeline (each step is a pure module):
//   1. Generation       — Gaussian-mixture sampling (generation.js)
//   2. Clustering       — mutual k-NN over all nodes (clustering.js)
//   3. Neighbourhoods   — mutual k-NN inside each cluster (neighbourhoods.js)
//   4. Taste            — Stages 2 + 3 of dynamics §3 (citation-taste.js)
//   5. Pair sampling    — Stage 4 of dynamics §3 (citations.js)
//
// Each step has its own seed where it makes sense and its own rerun lane.
// Modules don't mutate inputs.

import { generate, defaultGenerationParams, R_GLOBAL } from "./generation.js";
import {
  buildDebugGraph, colourForLink as genColourForLink,
  buildVolumeOutline, buildOriginMarker, debugFlags,
} from "./generation-debug.js";
import { inferClusters, defaultClusteringParams } from "./clustering.js";
import {
  decorateGraphData as decorateClusterDebug, buildCentroidMarker, clusterDebugFlags,
} from "./clustering-debug.js";
import { inferNeighbourhoods, defaultNeighbourhoodParams } from "./neighbourhoods.js";
import { buildCitationTaste, defaultTasteParams } from "./citation-taste.js";
import { generateCitations, defaultCitationParams } from "./citations.js";
import {
  decorateGraphData as decorateCitations, citationViewFlags, colourByInDegree,
} from "./citations-debug.js";
import { buildBaseEdges } from "./base-edges.js";
import { makeHybridForce, makeTensionCache } from "./hybrid-force.js";
import {
  physicsDebugFlags, colourForTension,
  buildDisplacementOverlay, updateDisplacementOverlay,
} from "./physics-debug.js";

const $ = (id) => document.getElementById(id);

const state = {
  // Committed generation params — what the canvas currently shows.
  params: defaultGenerationParams(),
  result: null,

  // Clustering params + result. mutualK is live; changing it reruns
  // inferClusters() against the existing genResult without regenerating.
  clusterParams: defaultClusteringParams(),
  clusterResult: null,

  // Neighbourhoods (Stage 1). neighbourK is in the citation modal; changing
  // it reruns from neighbourhoods downward.
  neighbourhoodParams: defaultNeighbourhoodParams(),
  neighbourhoodResult: null,

  // Taste (Stages 2 + 3). All knobs live in the citation modal.
  tasteParams: defaultTasteParams(),
  tasteResult: null,

  // Pair sampling (Stage 4). Top-level levers (density / intra / cross)
  // live in the left panel; ε's and seed live in the modal.
  citationParams: defaultCitationParams(),
  citationResult: null,

  // Layer 4 — physics. α drives the hybrid spring; frozen pauses the sim.
  // _baseDist is precomputed at generation time; _tensionCache is written
  // every tick by the force and read by debug overlays.
  alpha: 0.0,
  frozen: false,
  _baseDist: null,
  _tensionCache: null,

  // Render mode (bottom bar). "cluster" is the production default.
  colourBy: "cluster",

  // Edge visuals — render-only, no physics impact. Mirrors v1 fields.
  view: {
    showBase:        false,
    baseDensity:     0.05,
    baseGamma:       0.3,        // power transform for base opacity
    baseColour:      "#888888",
    citGamma:        0.3,        // direct linear opacity for citations
    citColour:       "#ff6b35",
    citArrows:       false,      // arrows show direction but get messy
  },
};

let Graph = null;
let volumeObject = null;
let displacementObject = null;

/* ── pipeline orchestration ─────────────────────────────────────────────── */
/* Each stage runs only when something at or above it has changed.
 * Helpers re-render at the end so callers don't forget. */

function regenerate() {
  state.result = generate(state.params);
  precomputeBaseDist();          // Layer 4 needs ‖basePos_i − basePos_j‖
  state._tensionCache = makeTensionCache(state.result.nodes.length);
  // Reseed live positions to basePos so α=0 is a clean visual no-op.
  // (Saved via liveById if you want them preserved across regens — we
  // explicitly do NOT here, because regen changes the embedding.)
  resetLivePositions();
  recluster();
}

// Pairwise Euclidean distance over basePos. Lives in main.js's state
// (`state._baseDist`) and is read by the force every tick via the getter
// passed to makeHybridForce. Recomputed once per regeneration.
function precomputeBaseDist() {
  const nodes = state.result.nodes;
  const n = nodes.length;
  const d = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    const pi = nodes[i].basePos;
    for (let j = i + 1; j < n; j++) {
      const pj = nodes[j].basePos;
      const dx = pi[0] - pj[0], dy = pi[1] - pj[1], dz = pi[2] - pj[2];
      const v = Math.sqrt(dx*dx + dy*dy + dz*dz);
      d[i * n + j] = v;
      d[j * n + i] = v;
    }
  }
  state._baseDist = d;
}

// Drop any live position cache so the next graph rebuild seeds nodes at
// basePos. Used after a regen (the embedding has changed; old positions
// are nonsense).
function resetLivePositions() {
  state._liveById = null;
}

function recluster() {
  state.clusterResult = inferClusters(state.result, state.clusterParams);
  rebuildClusterLegend();
  reneighbour();
}

function reneighbour() {
  state.neighbourhoodResult = inferNeighbourhoods(
    state.result, state.clusterResult, state.neighbourhoodParams,
  );
  retaste();
}

function retaste() {
  state.tasteResult = buildCitationTaste(
    state.clusterResult, state.neighbourhoodResult, state.tasteParams,
  );
  resample();
}

function resample() {
  state.citationResult = generateCitations(
    state.result, state.clusterResult, state.neighbourhoodResult,
    state.tasteResult, state.citationParams,
  );
  updateStatus();
  updateCitationStatus();
  loadGraphData();
  // Citations changing means hasCit changed, which means rest lengths for
  // many pairs changed → reheat so the new equilibrium gets pursued.
  if (Graph && !state.frozen) {
    Graph.d3ReheatSimulation();
    Graph.resumeAnimation();
  }
}

function updateStatus() {
  const r = state.result, c = state.clusterResult, n = state.neighbourhoodResult, ct = state.citationResult;
  $("status").textContent =
    `seed=${state.params.seed} · origins=${r.origins.length} · ` +
    `nodes=${r.nodes.length} · clusters=${c.clusters.length} · ` +
    `Ng=${n.neighbourhoods.length} · citations=${ct.citations.length}`;
}

function updateCitationStatus() {
  const p = state.citationResult.pools;
  $("cit-status").textContent =
    `intra ${p.intraPicked}/${p.intraValid} · cross ${p.crossPicked}/${p.crossValid}`;
}

/* ── render ─────────────────────────────────────────────────────────────── */

function colourForNode(node) {
  // Centroid markers always wear their cluster colour, regardless of mode.
  if (node.kind === "centroid") {
    return state.clusterResult.clusters[node.clusterId].colour;
  }
  // Origin markers always wear their origin colour.
  if (node.kind === "origin") {
    return state.result.origins[node.originId].colour;
  }
  // Data nodes follow the bottom-bar colour-by selector.
  switch (state.colourBy) {
    case "cluster": {
      const cid = state.clusterResult.nodeCluster[node.id];
      return state.clusterResult.clusters[cid].colour;
    }
    case "origin":
      return state.result.origins[node.originId].colour;
    case "indegree":
      return colourByInDegree(state.citationResult.inDeg, node.id);
    case "uniform":
    default:
      return "#cfd8e3";
  }
}

function colourForLink(link) {
  // Physics-debug overrides take precedence: when tension visualisation is
  // on for that link kind, colour by the live spring tension rather than
  // the user's chosen edge colour.
  if (link.kind === "citation") {
    if (physicsDebugFlags.tensionCitations) {
      const t = readTension(link);
      if (t !== null) return colourForTension(t);
    }
    return state.view.citColour;
  }
  if (link.kind === "base") {
    if (physicsDebugFlags.tensionBase) {
      const t = readTension(link);
      if (t !== null) return colourForTension(t);
    }
    return state.view.baseColour;
  }
  if (link.kind === "mutual-edge") return "#5dd39e";   // cluster-debug
  return genColourForLink(link, state.result.origins);
}

// Read live tension from the per-pair cache for a graph-data link.
// 3d-force-graph reifies link.source / link.target into node objects after
// graphData(); before then they're raw ids. Handle both.
function readTension(link) {
  const cache = state._tensionCache;
  if (!cache) return null;
  const n = state.result.nodes.length;
  const sId = typeof link.source === "object" ? link.source.id : link.source;
  const tId = typeof link.target === "object" ? link.target.id : link.target;
  if (typeof sId !== "number" || typeof tId !== "number") return null;
  return cache[sId * n + tId];
}

// Per-link opacity. Base uses a power transform (mid-tones matter most when
// fading dense base edges); citations are direct linear opacity for precise
// brightness control.
function opacityForLink(link) {
  if (link.kind === "base") {
    const g = Math.max(0.05, state.view.baseGamma || 1);
    return Math.pow(0.5, 1 / g);
  }
  if (link.kind === "citation") {
    return Math.max(0.02, Math.min(1, state.view.citGamma ?? 1));
  }
  if (link.kind === "mutual-edge") return 0.55;
  return 0.4;
}

function loadGraphData() {
  // Snapshot the previous graph's live positions so a rebuild (toggling a
  // debug overlay, changing citation rates, etc) doesn't reset nodes back
  // to basePos. After a regen, `state._liveById` is null so we fall back
  // to seeding from basePos.
  if (Graph) {
    const prev = Graph.graphData();
    if (prev && prev.nodes) {
      const m = new Map();
      for (const n of prev.nodes) {
        if (n.kind !== "node") continue;
        m.set(n.id, { x: n.x, y: n.y, z: n.z, vx: n.vx ?? 0, vy: n.vy ?? 0, vz: n.vz ?? 0 });
      }
      state._liveById = m;
    }
  }
  const data = buildDebugGraph(state.result, state._liveById);
  decorateClusterDebug(data, state.clusterResult);
  decorateCitations(data, state.citationResult);
  if (state.view.showBase) {
    for (const e of buildBaseEdges(state.result, state.view.baseDensity)) {
      data.links.push(e);
    }
  }
  const T = window.THREE;
  Graph
    .nodeColor(colourForNode)
    .nodeVal((n) => (n.kind === "origin" || n.kind === "centroid") ? 0.001 : 1)
    .nodeRelSize(2)
    .nodeThreeObject((n) => {
      if (n.kind === "origin") return buildOriginMarker(T, state.result.origins[n.originId]);
      if (n.kind === "centroid") return buildCentroidMarker(T, state.clusterResult.clusters[n.clusterId]);
      return null;
    })
    .nodeThreeObjectExtend(false)
    .nodeLabel((n) => {
      if (n.kind === "origin")   return `origin ${n.originId} (anchor)`;
      if (n.kind === "centroid") return `centroid · cluster ${n.clusterId}`;
      const cid = state.clusterResult.nodeCluster[n.id];
      return `#${n.id} · origin ${n.originId} · cluster ${cid} · t=${n.t.toFixed(2)}`;
    })
    .linkColor(colourForLink)
    .linkOpacity(0.9)              // overridden per-link via linkMaterial below
    .linkMaterial((l) => getLinkMaterial(l))
    .linkWidth((l) => {
      if (l.kind === "citation")    return 0.9;
      if (l.kind === "mutual-edge") return 0.6;
      if (l.kind === "base")        return 0.3;
      return 0.3;
    })
    .linkDirectionalArrowLength((l) => (l.kind === "citation" && state.view.citArrows) ? 2.2 : 0)
    .linkDirectionalArrowRelPos(1)
    .graphData(data);

  ensureVolumeOutline();
  ensureDisplacementOverlay();
  installPerLinkOpacityHook();
}

/* per-link material ownership: 3d-force-graph caches LineBasicMaterials /
   MeshLambertMaterials internally, indexed by colour string — multiple
   links of the same colour share ONE material instance. That's fatal for
   per-link opacity (last writer wins) AND for live colour updates (lib
   doesn't re-evaluate the colour accessor every frame; tension changes
   every frame, so it would never propagate). We bypass the cache by
   handing the lib a fresh MeshLambertMaterial per link via the
   linkMaterial accessor. The lib uses our material as-is and never
   replaces it. We then own colour + opacity, updated every frame in the
   rAF tick below. WeakMap keyed on the link object means materials are
   GC'd when graphData() rebuilds links. */
const _linkMatCache = new WeakMap();
function getLinkMaterial(link) {
  let m = _linkMatCache.get(link);
  if (!m) {
    const T = window.THREE;
    m = new T.MeshLambertMaterial({ transparent: true, depthWrite: false });
    _linkMatCache.set(link, m);
  }
  return m;
}
function installPerLinkOpacityHook() {
  if (installPerLinkOpacityHook._installed) return;
  installPerLinkOpacityHook._installed = true;
  const tick = () => {
    if (Graph) {
      const data = Graph.graphData();
      const links = data.links;
      for (const l of links) {
        const m = _linkMatCache.get(l);
        if (!m) continue;
        m.opacity = opacityForLink(l);
        const c = colourForLink(l);
        if (m.__lastColour !== c) {
          m.color.set(c);
          m.__lastColour = c;
        }
      }
      if (physicsDebugFlags.showDisplacement && displacementObject && state.result) {
        updateDisplacementOverlay(
          displacementObject,
          data.nodes,
          (id) => state.result.nodes[id]?.basePos,
        );
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function ensureVolumeOutline() {
  if (!Graph) return;
  const T = window.THREE;
  if (!T) return;
  const scene = Graph.scene();
  if (volumeObject) {
    scene.remove(volumeObject);
    volumeObject.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    volumeObject = null;
  }
  if (debugFlags.showVolume) {
    volumeObject = buildVolumeOutline(T, state.result.R);
    scene.add(volumeObject);
  }
}

// Same lifecycle pattern as ensureVolumeOutline. Rebuilds when the data
// node count changes (so a regen with a different N gets a correctly-sized
// vertex buffer).
function ensureDisplacementOverlay() {
  if (!Graph) return;
  const T = window.THREE;
  if (!T || !state.result) return;
  const scene = Graph.scene();
  const wantN = state.result.nodes.length;
  const haveN = displacementObject
    ? displacementObject.geometry.attributes.position.array.length / 6
    : 0;
  const sizeMismatch = displacementObject && haveN !== wantN;
  if (displacementObject && (!physicsDebugFlags.showDisplacement || sizeMismatch)) {
    scene.remove(displacementObject);
    displacementObject.geometry.dispose();
    displacementObject.material.dispose();
    displacementObject = null;
  }
  if (physicsDebugFlags.showDisplacement && !displacementObject) {
    displacementObject = buildDisplacementOverlay(T, wantN);
    scene.add(displacementObject);
  }
}

/* ── cluster legend ─────────────────────────────────────────────────────── */

function rebuildClusterLegend() {
  const root = $("cluster-legend");
  root.innerHTML = "";
  for (const c of state.clusterResult.clusters) {
    const row = document.createElement("div");
    row.className = "cluster-row";
    row.innerHTML = `
      <span class="swatch" style="background:${c.colour}"></span>
      <span>cluster ${c.id}</span>
      <span class="meta">n=${c.count} · σ=${c.spread.toFixed(1)}</span>
    `;
    root.appendChild(row);
  }
}

/* ── dropdown menus ─────────────────────────────────────────────────────── */

function bindDropdowns() {
  const menus = document.querySelectorAll(".menu");
  for (const m of menus) {
    const trigger = m.querySelector(":scope > .tb-btn");
    if (!trigger) continue;
    trigger.onclick = (e) => {
      e.stopPropagation();
      const wasOpen = m.classList.contains("open");
      for (const mm of menus) mm.classList.remove("open");
      if (!wasOpen) m.classList.add("open");
    };
  }
  document.addEventListener("click", () => {
    for (const m of menus) m.classList.remove("open");
  });
  for (const m of menus) {
    const list = m.querySelector(":scope > .menu-list");
    if (list) list.addEventListener("click", (e) => e.stopPropagation());
  }
}

/* ── debug overlay toggles ──────────────────────────────────────────────── */

function bindDebugToggles() {
  // Generation overlays.
  $("dbg-origins").checked      = debugFlags.showOrigins;
  $("dbg-origin-edges").checked = debugFlags.showOriginEdges;
  $("dbg-volume").checked       = debugFlags.showVolume;
  $("dbg-origins").onchange      = (e) => { debugFlags.showOrigins     = e.target.checked; loadGraphData(); };
  $("dbg-origin-edges").onchange = (e) => { debugFlags.showOriginEdges = e.target.checked; loadGraphData(); };
  $("dbg-volume").onchange       = (e) => { debugFlags.showVolume      = e.target.checked; ensureVolumeOutline(); };

  // Clustering overlays.
  $("dbg-centroids").checked     = clusterDebugFlags.showCentroids;
  $("dbg-mutual-edges").checked  = clusterDebugFlags.showMutualEdges;
  $("dbg-centroids").onchange    = (e) => { clusterDebugFlags.showCentroids   = e.target.checked; loadGraphData(); };
  $("dbg-mutual-edges").onchange = (e) => { clusterDebugFlags.showMutualEdges = e.target.checked; loadGraphData(); };

  // Physics overlays. Both are render-only (the per-link colour callback
  // reads physicsDebugFlags) so toggling doesn't rebuild graph data; we
  // just nudge the link-colour function so the lib applies it.
  $("dbg-tension-cit").checked   = physicsDebugFlags.tensionCitations;
  $("dbg-tension-base").checked  = physicsDebugFlags.tensionBase;
  $("dbg-displacement").checked  = physicsDebugFlags.showDisplacement;
  $("dbg-tension-cit").onchange  = (e) => { physicsDebugFlags.tensionCitations = e.target.checked; if (Graph) Graph.linkColor(colourForLink); };
  $("dbg-tension-base").onchange = (e) => { physicsDebugFlags.tensionBase      = e.target.checked; if (Graph) Graph.linkColor(colourForLink); };
  $("dbg-displacement").onchange = (e) => { physicsDebugFlags.showDisplacement = e.target.checked; ensureDisplacementOverlay(); };
}

/* ── settings modal ─────────────────────────────────────────────────────── */

let pending = null;

function openSettings() {
  pending = { ...state.params };
  $("set-nodes").value         = pending.nodeCount;
  $("set-nodes-range").value   = pending.nodeCount;
  $("set-origins").value       = pending.pointsOfOrigin;
  $("set-origins-range").value = pending.pointsOfOrigin;
  $("set-spread-range").value  = pending.spreadScale;
  $("set-spread-val").textContent = (+pending.spreadScale).toFixed(2);
  $("settings-modal").classList.add("open");
}
function closeSettings() {
  $("settings-modal").classList.remove("open");
  pending = null;
}
function commitSettingsAndGenerate() {
  if (!pending) return;
  pending.nodeCount      = Math.max(1, Math.min(2000, pending.nodeCount | 0));
  pending.pointsOfOrigin = Math.max(1, Math.min(pending.nodeCount, pending.pointsOfOrigin | 0));
  pending.spreadScale    = Math.max(0, +pending.spreadScale || 1);
  state.params = { ...state.params, ...pending };
  closeSettings();
  regenerate();
}
function bindSettings() {
  $("btn-settings").onclick   = openSettings;
  $("settings-close").onclick = closeSettings;
  $("settings-x").onclick     = closeSettings;
  $("settings-generate").onclick = commitSettingsAndGenerate;
  $("settings-modal").addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") closeSettings();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("settings-modal").classList.contains("open")) closeSettings();
  });

  const syncNodes = (v) => {
    v = Math.max(1, Math.min(2000, parseInt(v, 10) || 1));
    $("set-nodes").value = v;
    $("set-nodes-range").value = v;
    if (pending) pending.nodeCount = v;
    if (pending && pending.pointsOfOrigin > v) {
      pending.pointsOfOrigin = v;
      $("set-origins").value = v;
      $("set-origins-range").value = v;
    }
  };
  $("set-nodes").oninput       = (e) => syncNodes(e.target.value);
  $("set-nodes-range").oninput = (e) => syncNodes(e.target.value);

  const syncOrigins = (v) => {
    const cap = pending ? pending.nodeCount : 2000;
    v = Math.max(1, Math.min(cap, parseInt(v, 10) || 1));
    $("set-origins").value = v;
    $("set-origins-range").value = v;
    if (pending) pending.pointsOfOrigin = v;
  };
  $("set-origins").oninput       = (e) => syncOrigins(e.target.value);
  $("set-origins-range").oninput = (e) => syncOrigins(e.target.value);

  $("set-spread-range").oninput = (e) => {
    const v = +e.target.value;
    $("set-spread-val").textContent = v.toFixed(2);
    if (pending) pending.spreadScale = v;
  };
}

/* ── topbar (Generate, seed, Freeze) ────────────────────────────────────── */

function bindTopbar() {
  $("seed-input").value = state.params.seed;
  $("seed-input").onchange = (e) => {
    state.params.seed = parseInt(e.target.value, 10) || 0;
    regenerate();
  };
  $("btn-generate").onclick = () => regenerate();
  $("btn-freeze").onclick = () => {
    state.frozen = !state.frozen;
    $("btn-freeze").classList.toggle("active", state.frozen);
    if (!Graph) return;
    if (state.frozen) Graph.pauseAnimation();
    else              Graph.resumeAnimation();
  };
}

/* ── left panel: clustering ─────────────────────────────────────────────── */

function bindClusterControls() {
  $("mutualk-input").value = state.clusterParams.mutualK;
  $("mutualk-val").textContent = String(state.clusterParams.mutualK);
  $("mutualk-input").oninput = (e) => {
    const k = +e.target.value | 0;
    state.clusterParams.mutualK = k;
    $("mutualk-val").textContent = String(k);
    recluster();
  };
}

/* ── left panel: force ──────────────────────────────────────────────────── */

function bindForceControls() {
  $("alpha-input").value = state.alpha;
  $("alpha-val").textContent = state.alpha.toFixed(2);
  // α touches force parameters only — no data invalidation. But the d3
  // simulation's INTERNAL simAlpha decays over time and is what scales the
  // force impulse each tick (k = STRENGTH · sMul · simAlpha · …). After
  // the sim has cooled, dragging α will read the new value but with
  // simAlpha ≈ alphaMin → impulse ≈ 0 → nothing moves. So we must
  // d3ReheatSimulation() on every α change to kick simAlpha back up.
  $("alpha-input").oninput = (e) => {
    state.alpha = +e.target.value;
    $("alpha-val").textContent = state.alpha.toFixed(2);
    if (!Graph) return;
    if (state.frozen) return;
    Graph.d3ReheatSimulation();
    Graph.resumeAnimation();
  };
}

/* ── left panel: citations ──────────────────────────────────────────────── */

function bindCitationControls() {
  const p = state.citationParams;
  $("cit-density").value     = p.density;     $("cit-density-val").textContent = p.density.toFixed(2);
  $("cit-intra").value       = p.intraRate;   $("cit-intra-val").textContent   = p.intraRate.toFixed(2);
  $("cit-cross").value       = p.crossRate;   $("cit-cross-val").textContent   = p.crossRate.toFixed(2);
  $("cit-seed").value        = p.samplingSeed;

  $("cit-density").oninput = (e) => {
    p.density = +e.target.value;
    $("cit-density-val").textContent = p.density.toFixed(2);
    resample();
  };
  $("cit-intra").oninput = (e) => {
    p.intraRate = +e.target.value;
    $("cit-intra-val").textContent = p.intraRate.toFixed(2);
    resample();
  };
  $("cit-cross").oninput = (e) => {
    p.crossRate = +e.target.value;
    $("cit-cross-val").textContent = p.crossRate.toFixed(2);
    resample();
  };
  $("cit-seed").onchange = (e) => {
    p.samplingSeed = parseInt(e.target.value, 10) || 0;
    resample();
  };
  $("cit-randomize").onclick = () => {
    p.samplingSeed = Math.floor(Math.random() * 1e9);
    $("cit-seed").value = p.samplingSeed;
    resample();
  };
}

/* ── citation settings modal (apply-on-Apply) ──────────────────────────── */
// All the deeper citation knobs live here, including the Stage 1 / Stage 2
// + 3 / Stage 4 controls. Like the generation modal, a local buffer holds
// pending changes; Apply commits them and fires the right rerun lane.

let citPending = null;

function openCitationModal() {
  citPending = {
    neighbourK:    state.neighbourhoodParams.neighbourK,
    favouritesMean: state.tasteParams.favouritesMean,
    sharedTaste:    state.tasteParams.sharedTaste,
    tasteRange:     state.tasteParams.tasteRange,
    transitiveBoost:state.tasteParams.transitiveBoost,
    tasteSeed:      state.tasteParams.tasteSeed,
    density:        state.citationParams.density,
    intraRate:      state.citationParams.intraRate,
    crossRate:      state.citationParams.crossRate,
    epsilonIntra:   state.citationParams.epsilonIntra,
    epsilonCross:   state.citationParams.epsilonCross,
    samplingSeed:   state.citationParams.samplingSeed,
  };
  // hydrate inputs from pending
  hydrateCitModal();
  updateCitationModalStatus();
  $("cit-modal").classList.add("open");
}
function closeCitationModal() {
  $("cit-modal").classList.remove("open");
  citPending = null;
}
function commitCitationModalAndApply() {
  if (!citPending) return;

  // Detect which stage(s) changed so we can pick the cheapest rerun.
  const np = state.neighbourhoodParams;
  const tp = state.tasteParams;
  const cp = state.citationParams;

  const neighChanged =
    citPending.neighbourK !== np.neighbourK;
  const tasteChanged = neighChanged ||
    citPending.favouritesMean   !== tp.favouritesMean   ||
    citPending.sharedTaste      !== tp.sharedTaste      ||
    citPending.tasteRange       !== tp.tasteRange       ||
    citPending.transitiveBoost  !== tp.transitiveBoost  ||
    citPending.tasteSeed        !== tp.tasteSeed;
  // Sampling always re-runs at minimum (cheap, and the user clicked Apply).

  // Commit pending → state.
  np.neighbourK      = Math.max(1, citPending.neighbourK | 0);
  tp.favouritesMean  = Math.max(0.1, +citPending.favouritesMean);
  tp.sharedTaste     = Math.max(0,   +citPending.sharedTaste);
  tp.tasteRange      = Math.max(0.5, +citPending.tasteRange);
  tp.transitiveBoost = Math.max(0,   Math.min(1, +citPending.transitiveBoost));
  tp.tasteSeed       = citPending.tasteSeed | 0;
  cp.density         = Math.max(0, Math.min(1, +citPending.density));
  cp.intraRate       = Math.max(0, Math.min(1, +citPending.intraRate));
  cp.crossRate       = Math.max(0, Math.min(1, +citPending.crossRate));
  cp.epsilonIntra    = Math.max(0, +citPending.epsilonIntra);
  cp.epsilonCross    = Math.max(0, +citPending.epsilonCross);
  cp.samplingSeed    = citPending.samplingSeed | 0;

  // Sync the left-panel sliders so they reflect what we just committed.
  syncCitationLeftPanel();

  closeCitationModal();
  if (neighChanged)      reneighbour();
  else if (tasteChanged) retaste();
  else                   resample();
}

function hydrateCitModal() {
  const p = citPending;
  $("cm-density").value     = p.density;     $("cm-density-val").textContent     = p.density.toFixed(2);
  $("cm-intra").value       = p.intraRate;   $("cm-intra-val").textContent       = p.intraRate.toFixed(2);
  $("cm-cross").value       = p.crossRate;   $("cm-cross-val").textContent       = p.crossRate.toFixed(2);
  $("cm-eps-intra").value   = p.epsilonIntra;$("cm-eps-intra-val").textContent   = p.epsilonIntra.toFixed(3);
  $("cm-eps-cross").value   = p.epsilonCross;$("cm-eps-cross-val").textContent   = p.epsilonCross.toFixed(3);
  $("cm-sampling-seed").value = p.samplingSeed;
  $("cm-neighbourk").value  = p.neighbourK;  $("cm-neighbourk-val").textContent  = String(p.neighbourK);
  $("cm-fav-mean").value    = p.favouritesMean; $("cm-fav-mean-val").textContent  = (+p.favouritesMean).toFixed(1);
  $("cm-shared").value      = p.sharedTaste; $("cm-shared-val").textContent      = (+p.sharedTaste).toFixed(2);
  $("cm-taste-range").value = p.tasteRange;  $("cm-taste-range-val").textContent = (+p.tasteRange).toFixed(1);
  $("cm-trans").value       = p.transitiveBoost; $("cm-trans-val").textContent   = (+p.transitiveBoost).toFixed(2);
  $("cm-taste-seed").value  = p.tasteSeed;
}

function updateCitationModalStatus() {
  const p = state.citationResult.pools;
  $("cm-status").textContent =
    `intra ${p.intraPicked} / ${p.intraValid}    cross ${p.crossPicked} / ${p.crossValid}`;
}

function syncCitationLeftPanel() {
  const p = state.citationParams;
  $("cit-density").value = p.density;     $("cit-density-val").textContent = p.density.toFixed(2);
  $("cit-intra").value   = p.intraRate;   $("cit-intra-val").textContent   = p.intraRate.toFixed(2);
  $("cit-cross").value   = p.crossRate;   $("cit-cross-val").textContent   = p.crossRate.toFixed(2);
  $("cit-seed").value    = p.samplingSeed;
}

function bindCitationModal() {
  $("cit-settings-open").onclick = openCitationModal;
  $("cit-modal-cancel").onclick  = closeCitationModal;
  $("cit-modal-x").onclick       = closeCitationModal;
  $("cit-modal-apply").onclick   = commitCitationModalAndApply;
  $("cit-modal").addEventListener("click", (e) => {
    if (e.target.id === "cit-modal") closeCitationModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && $("cit-modal").classList.contains("open")) closeCitationModal();
  });

  // Each input mutates the pending buffer. No commit → no side effects.
  const bindRange = (id, valId, key, fmt) => {
    $(id).oninput = (e) => {
      const v = +e.target.value;
      if (citPending) citPending[key] = v;
      $(valId).textContent = fmt(v);
    };
  };
  bindRange("cm-density",   "cm-density-val",   "density",        v => v.toFixed(2));
  bindRange("cm-intra",     "cm-intra-val",     "intraRate",      v => v.toFixed(2));
  bindRange("cm-cross",     "cm-cross-val",     "crossRate",      v => v.toFixed(2));
  bindRange("cm-eps-intra", "cm-eps-intra-val", "epsilonIntra",   v => v.toFixed(3));
  bindRange("cm-eps-cross", "cm-eps-cross-val", "epsilonCross",   v => v.toFixed(3));
  bindRange("cm-fav-mean",  "cm-fav-mean-val",  "favouritesMean", v => v.toFixed(1));
  bindRange("cm-shared",    "cm-shared-val",    "sharedTaste",    v => v.toFixed(2));
  bindRange("cm-taste-range","cm-taste-range-val","tasteRange",   v => v.toFixed(1));
  bindRange("cm-trans",     "cm-trans-val",     "transitiveBoost",v => v.toFixed(2));

  $("cm-neighbourk").oninput = (e) => {
    const v = (+e.target.value) | 0;
    if (citPending) citPending.neighbourK = v;
    $("cm-neighbourk-val").textContent = String(v);
  };
  $("cm-sampling-seed").onchange = (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    if (citPending) citPending.samplingSeed = v;
  };
  $("cm-taste-seed").onchange = (e) => {
    const v = parseInt(e.target.value, 10) || 0;
    if (citPending) citPending.tasteSeed = v;
  };
  $("cm-sampling-randomize").onclick = () => {
    const v = Math.floor(Math.random() * 1e9);
    $("cm-sampling-seed").value = v;
    if (citPending) citPending.samplingSeed = v;
  };
  $("cm-taste-randomize").onclick = () => {
    const v = Math.floor(Math.random() * 1e9);
    $("cm-taste-seed").value = v;
    if (citPending) citPending.tasteSeed = v;
  };
}

/* ── bottom bar: base / citation / nodes groups ─────────────────────────── */

function bindBottomBar() {
  const v = state.view;

  // BASE EDGES
  $("show-base").checked = v.showBase;
  $("base-density").value = v.baseDensity;
  $("base-density-val").textContent = v.baseDensity.toFixed(3);
  $("base-gamma").value = v.baseGamma;
  $("base-gamma-val").textContent = v.baseGamma.toFixed(2);
  $("base-colour").value = v.baseColour;

  $("show-base").onchange = (e) => {
    v.showBase = e.target.checked;
    loadGraphData();              // toggling visibility changes the link list
  };
  $("base-density").oninput = (e) => {
    v.baseDensity = +e.target.value;
    $("base-density-val").textContent = v.baseDensity.toFixed(3);
    if (v.showBase) loadGraphData();   // density only matters when shown
  };
  $("base-gamma").oninput = (e) => {
    v.baseGamma = +e.target.value;
    $("base-gamma-val").textContent = v.baseGamma.toFixed(2);
    // Gamma is render-only; the per-link opacity hook reads state.view
    // every frame, so no rebuild needed.
  };
  $("base-colour").oninput = (e) => {
    v.baseColour = e.target.value;
    if (Graph) Graph.linkColor(colourForLink);
  };

  // CITATION EDGES
  $("show-citations").checked = citationViewFlags.showCitations;
  $("cit-gamma").value = v.citGamma;
  $("cit-gamma-val").textContent = v.citGamma.toFixed(2);
  $("cit-colour").value = v.citColour;

  $("show-citations").onchange = (e) => {
    citationViewFlags.showCitations = e.target.checked;
    loadGraphData();
  };
  $("show-cit-arrows").checked = v.citArrows;
  $("show-cit-arrows").onchange = (e) => {
    v.citArrows = e.target.checked;
    if (Graph) {
      Graph.linkDirectionalArrowLength((l) => (l.kind === "citation" && v.citArrows) ? 2.2 : 0);
      Graph.refresh();
    }
  };
  $("cit-gamma").oninput = (e) => {
    v.citGamma = +e.target.value;
    $("cit-gamma-val").textContent = v.citGamma.toFixed(2);
  };
  $("cit-colour").oninput = (e) => {
    v.citColour = e.target.value;
    if (Graph) Graph.linkColor(colourForLink);
  };

  // NODES
  $("colour-by").value = state.colourBy;
  $("colour-by").onchange = (e) => {
    state.colourBy = e.target.value;
    if (Graph) {
      Graph.nodeColor(colourForNode);
      Graph.refresh();
    }
  };
}

/* ── 3D graph init ──────────────────────────────────────────────────────── */

function initGraph() {
  const el = $("graph");
  const rect = el.getBoundingClientRect();
  Graph = ForceGraph3D()(el)
    .width(rect.width)
    .height(rect.height)
    .backgroundColor("#06080c")
    .nodeRelSize(2)
    .nodeOpacity(1.0)
    // Run the simulation forever; pause via the Freeze button. Without
    // this, d3-force-3d cools down and stops applying forces — α changes
    // would then have no visible effect until you reheated.
    .cooldownTicks(Infinity)
    .warmupTicks(60);

  // Disable the library's default forces: hybrid spring is the only force
  // shaping the layout. Charge would fight cited contraction at high α and
  // produce shake; the lib's default link spring would double-count.
  const charge = Graph.d3Force("charge"); if (charge && charge.strength) charge.strength(0);
  const link   = Graph.d3Force("link");   if (link   && link.strength)   link.strength(0);
  const center = Graph.d3Force("center"); if (center && center.strength) center.strength(0);

  // Register the hybrid spring. Force closure reads α / hasCit / baseDist
  // every tick via getters, so structural changes (citation reroll, etc)
  // take effect on the next frame without re-registration.
  Graph.d3Force("hybrid", makeHybridForce({
    getAlpha:        () => state.alpha,
    getBaseDist:     () => state._baseDist,
    getHasCit:       () => state.citationResult ? state.citationResult.hasCit : null,
    getTensionCache: () => state._tensionCache,
  }));

  // High velocity decay = a lot of damping = slow, smooth settling. Value
  // chosen so dragging α doesn't ping nodes around — they ease into the
  // new equilibrium. Hardcoded; not a user knob.
  Graph.d3VelocityDecay(0.7);

  const ctrls = Graph.controls();
  if (ctrls) {
    ctrls.rotateSpeed = 2.2;
    ctrls.zoomSpeed   = 2.5;
    ctrls.panSpeed    = 1.6;
    ctrls.enableDamping = false;
  }

  new ResizeObserver((entries) => {
    if (!Graph) return;
    const r = entries[0].contentRect;
    Graph.width(r.width).height(r.height);
  }).observe(el);
}

/* ── boot ───────────────────────────────────────────────────────────────── */

export function boot() {
  bindDropdowns();
  bindDebugToggles();
  bindSettings();
  bindTopbar();
  bindClusterControls();
  bindForceControls();
  bindCitationControls();
  bindCitationModal();
  bindBottomBar();

  // Run the full pipeline once. Status / legend / graph data are populated
  // as side-effects of resample() at the bottom of the chain.
  state.result = generate(state.params);
  precomputeBaseDist();
  state._tensionCache = makeTensionCache(state.result.nodes.length);
  state.clusterResult = inferClusters(state.result, state.clusterParams);
  rebuildClusterLegend();
  state.neighbourhoodResult = inferNeighbourhoods(state.result, state.clusterResult, state.neighbourhoodParams);
  state.tasteResult = buildCitationTaste(state.clusterResult, state.neighbourhoodResult, state.tasteParams);
  state.citationResult = generateCitations(
    state.result, state.clusterResult, state.neighbourhoodResult,
    state.tasteResult, state.citationParams,
  );
  updateStatus();
  updateCitationStatus();

  requestAnimationFrame(() => {
    initGraph();
    loadGraphData();
    Graph.cameraPosition({ x: 0, y: 0, z: R_GLOBAL * 4 }, { x: 0, y: 0, z: 0 }, 0);
    // expose for debugging in DevTools console
    window.__nt = {
      Graph, state, physicsDebugFlags, citationViewFlags,
      colourForLink, opacityForLink, readTension,
      linkMatCache: _linkMatCache,
    };
  });
}
