// 3D viewer panel.
//
// Ports the core 3d-force-graph setup from the legacy main.js into
// the new panel contract: mount(container, state, config) returns
// { update(state), destroy() }. Reads engine outputs from state and
// rebuilds graph data when state.engineRevision bumps.
//
// Live position is the per-frame blend (1-α)·basePos + α·alignedCit.
// The blend hook is registered with d3-force-3d once per panel
// instance; getters read current state every tick so slider drag,
// citation reroll, and regeneration take effect on the next frame.
//
// d3VelocityDecay = 1.0 zeros velocities every tick — the lib's
// `x += vx; vx *= 0` integration becomes a no-op alongside the
// blend hook's direct writes to node.x/y/z. Charge / link / center
// forces are explicitly disabled so nothing fights the blend.
//
// Simplified vs legacy: no debug overlays (origins, centroids,
// noise rings, base edges, structure edges). Keeps just data
// nodes coloured by cluster + citation links. Extra overlays land
// in slice 6 once the panel system is exercised.

import { makeBlendForce } from "../../blend/blend.js";
import { getState }       from "../state.js";

export const ID = "viewer-3d";
export const LABEL = "3D viewer";
export const DESCRIPTION = "Live blend visualisation; per-frame interpolation between basePos and aligned citation layout.";

const R_GLOBAL = 60;        // matches generation.js's working half-extent

export function mount(container, _state, _config = {}) {
  // The lib needs an absolutely-sized div to anchor itself in.
  container.innerHTML = "";
  container.style.height = "100%";
  container.style.position = "relative";

  const graphDiv = document.createElement("div");
  graphDiv.style.width    = "100%";
  graphDiv.style.height   = "100%";
  graphDiv.style.position = "absolute";
  graphDiv.style.inset    = "0";
  container.appendChild(graphDiv);

  let Graph = null;
  let lastDataRevision = -1;
  let resizeObs = null;

  function init() {
    if (!window.ForceGraph3D) {
      console.warn("[viewer-3d] ForceGraph3D not loaded yet");
      return;
    }
    const rect = graphDiv.getBoundingClientRect();
    Graph = window.ForceGraph3D()(graphDiv)
      .width(Math.max(1, rect.width))
      .height(Math.max(1, rect.height))
      .backgroundColor("#06080c")
      .nodeRelSize(2)
      .nodeOpacity(1.0)
      .cooldownTicks(Infinity)        // keep ticking forever; blend needs it
      .warmupTicks(60);

    // Disable default forces — blend hook owns positions.
    const charge = Graph.d3Force("charge"); if (charge && charge.strength) charge.strength(0);
    const link   = Graph.d3Force("link");   if (link   && link.strength)   link.strength(0);
    const center = Graph.d3Force("center"); if (center && center.strength) center.strength(0);

    // Blend hook reads state through getters every tick.
    Graph.d3Force("blend", makeBlendForce({
      getBasePos:            () => getState()._basePos,
      getAlignedCitationPos: () => getState().alignedCitationLayout,
      getBlend:              () => getState().blend,
    }));
    Graph.d3VelocityDecay(1.0);

    const ctrls = Graph.controls();
    if (ctrls) {
      ctrls.rotateSpeed   = 2.2;
      ctrls.zoomSpeed     = 2.5;
      ctrls.panSpeed      = 1.6;
      ctrls.enableDamping = false;
    }

    Graph.cameraPosition(
      { x: 0, y: 0, z: R_GLOBAL * 4 },
      { x: 0, y: 0, z: 0 },
      0,
    );

    resizeObs = new ResizeObserver((entries) => {
      if (!Graph) return;
      const r = entries[0].contentRect;
      Graph.width(Math.max(1, r.width)).height(Math.max(1, r.height));
    });
    resizeObs.observe(graphDiv);
  }

  // Build node + link arrays from current engine outputs.
  function rebuildData() {
    if (!Graph) return;
    const s = getState();
    if (!s.genResult) return;

    const nodes = [];
    const liveById = readLivePositions(Graph);
    for (const n of s.genResult.nodes) {
      const cid = s.clusterResult ? s.clusterResult.nodeCluster[n.id] : -1;
      const cluster = (cid >= 0 && s.clusterResult) ? s.clusterResult.clusters[cid] : null;
      const colour = cluster ? cluster.colour : "#888888";

      const seed = liveById.get(n.id);
      nodes.push({
        id:    n.id,
        kind:  "node",
        t:     n.t,
        clusterId: cid,
        colour,
        // Seed live position from the previous graph tick if present;
        // otherwise from basePos directly. Without a seed, the lib
        // would put new nodes at random positions and the first frame
        // would jump.
        x: seed ? seed.x : (s._basePos ? s._basePos[n.id*3]   : 0),
        y: seed ? seed.y : (s._basePos ? s._basePos[n.id*3+1] : 0),
        z: seed ? seed.z : (s._basePos ? s._basePos[n.id*3+2] : 0),
      });
    }

    const links = [];
    if (s.citationResult && s.citationResult.citations) {
      for (const c of s.citationResult.citations) {
        links.push({ source: c.source, target: c.target, kind: "citation" });
      }
    }

    Graph
      .nodeColor((n) => n.colour || "#888")
      .nodeVal(() => 1)
      .nodeLabel((n) => `#${n.id} · cluster ${n.clusterId} · t=${(n.t ?? 0).toFixed(2)}`)
      .linkColor(() => "#888888")
      .linkOpacity(0.35)
      .linkWidth(0.6)
      .linkDirectionalArrowLength(2)
      .linkDirectionalArrowRelPos(1)
      .graphData({ nodes, links });

    Graph.d3ReheatSimulation();
  }

  // Snapshot the previous tick's live positions so a rebuild
  // (cluster recolour, citation reroll, etc.) doesn't reset nodes
  // back to basePos.
  function readLivePositions(graph) {
    const m = new Map();
    if (!graph) return m;
    const prev = graph.graphData();
    if (prev && prev.nodes) {
      for (const n of prev.nodes) {
        if (n.kind !== "node") continue;
        m.set(n.id, { x: n.x, y: n.y, z: n.z });
      }
    }
    return m;
  }

  // Initial mount.
  init();
  if (Graph) rebuildData();
  lastDataRevision = getState().engineRevision;

  return {
    update(s) {
      if (!Graph) return;
      // Rebuild only when the engine has produced new data.
      // Slider drags / panel switches come through update() too;
      // those don't need a graphData rebuild.
      if (s.engineRevision !== lastDataRevision) {
        rebuildData();
        lastDataRevision = s.engineRevision;
      }
    },
    destroy() {
      if (resizeObs) {
        try { resizeObs.disconnect(); } catch (_) {}
        resizeObs = null;
      }
      // 3d-force-graph doesn't expose a clean teardown; tear down
      // the WebGL context indirectly by clearing the container.
      // (Sufficient for slot remount; if mounting/unmounting becomes
      // frequent we add explicit GL cleanup.)
      try { if (Graph) Graph._destructor && Graph._destructor(); } catch (_) {}
      Graph = null;
      container.innerHTML = "";
    },
  };
}
