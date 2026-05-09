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

import { makeBlendForce }              from "../../blend/blend.js";
import { getState, update }            from "../state.js";

export const ID = "viewer-3d";
export const LABEL = "3D viewer";
export const DESCRIPTION = "Live blend visualisation; per-frame interpolation between basePos and aligned citation layout.";

const R_GLOBAL = 60;        // matches generation.js's working half-extent

const DEFAULT_CAMERA = {
  rotateSpeed:  1.0,    // OrbitControls/TrackballControls native default; legacy was 2.2
  zoomSpeed:    1.0,    // legacy was 2.5
  panSpeed:     1.0,    // legacy was 1.6
  // 3d-force-graph uses TrackballControls. staticMoving=false (its default)
  // gives the camera inertia/coasting after mouse release — the "acceleration"
  // feel. We default to true (no inertia, click-and-stick) and let the user
  // re-enable smooth motion via the settings popup if they want it.
  smoothMotion: false,
};

export function mount(container, _state, config = {}) {
  // Apply config defaults — anything missing uses DEFAULT_CAMERA.
  const cam = { ...DEFAULT_CAMERA, ...config };

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

  // Settings overlay (gear button + popup with sliders).
  const settingsRoot = buildSettingsOverlay(container, cam, (newCam) => {
    Object.assign(cam, newCam);
    applyCameraToControls();
    persistCamConfig(newCam);
  });

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

    applyCameraToControls();

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

  // Apply the current camera-speed values to the live controls.
  // Called on init and whenever the settings overlay changes them.
  function applyCameraToControls() {
    if (!Graph) return;
    const ctrls = Graph.controls();
    if (!ctrls) return;
    ctrls.rotateSpeed = cam.rotateSpeed;
    ctrls.zoomSpeed   = cam.zoomSpeed;
    ctrls.panSpeed    = cam.panSpeed;
    // staticMoving is the TrackballControls switch for "no inertia."
    // dynamicDampingFactor only matters when staticMoving=false; we
    // still set it so toggling smoothMotion back on gives a sensible
    // damping rate without the user having to find another knob.
    ctrls.staticMoving           = !cam.smoothMotion;
    ctrls.dynamicDampingFactor   = cam.smoothMotion ? 0.2 : 0;
    // OrbitControls equivalent — kept defensive in case 3d-force-graph
    // is ever switched to controlType('orbit'). Otherwise no-op.
    if ("enableDamping" in ctrls) ctrls.enableDamping = !!cam.smoothMotion;
  }

  // Persist the camera config back into state.panels.primary.config
  // so the values survive a panel re-mount (algorithm switch / data
  // reload). Reads-then-writes the slot for whichever slot we live in.
  function persistCamConfig(_partial) {
    const s = getState();
    let mySlot = null;
    for (const slot of Object.keys(s.panels)) {
      if (s.panels[slot].type === ID) {
        mySlot = slot;
        break;
      }
    }
    if (!mySlot) return;
    const cur = s.panels[mySlot].config || {};
    update({
      panels: {
        ...s.panels,
        [mySlot]: { type: ID, config: { ...cur, ...cam } },
      },
    });
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
      if (settingsRoot) settingsRoot.remove();
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

/* ── settings overlay ───────────────────────────────────────────────── */

function buildSettingsOverlay(container, cam, onChange) {
  const root = document.createElement("div");
  root.className = "viewer-3d-settings";

  const toggle = document.createElement("button");
  toggle.className = "viewer-3d-settings-toggle";
  toggle.title = "Camera speed";
  toggle.textContent = "⚙";
  root.appendChild(toggle);

  const popup = document.createElement("div");
  popup.className = "viewer-3d-settings-popup";

  const heading = document.createElement("h4");
  heading.textContent = "Camera";
  popup.appendChild(heading);

  popup.appendChild(speedRow("Rotate", "rotateSpeed", cam.rotateSpeed, cam, onChange));
  popup.appendChild(speedRow("Zoom",   "zoomSpeed",   cam.zoomSpeed,   cam, onChange));
  popup.appendChild(speedRow("Pan",    "panSpeed",    cam.panSpeed,    cam, onChange));

  popup.appendChild(toggleRow(
    "Smooth motion",
    "smoothMotion",
    cam.smoothMotion,
    cam,
    onChange,
    "Camera inertia after mouse release. Off = click-and-stick.",
  ));

  const hint = document.createElement("div");
  hint.style.fontSize = "10px";
  hint.style.color = "var(--text-faint)";
  hint.style.marginTop = "6px";
  hint.textContent = "1.0 = native speed; >1 faster";
  popup.appendChild(hint);

  root.appendChild(popup);
  container.appendChild(root);

  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    popup.classList.toggle("open");
  });
  // Click outside the popup closes it.
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) popup.classList.remove("open");
  });

  return root;
}

function toggleRow(labelText, key, value, cam, onChange, title = "") {
  const row = document.createElement("div");
  row.className = "viewer-3d-settings-row toggle";
  row.title = title;

  const label = document.createElement("label");
  label.textContent = labelText;
  row.appendChild(label);

  const wrap = document.createElement("div");
  wrap.style.gridColumn = "2 / 4";
  wrap.style.display = "flex";
  wrap.style.justifyContent = "flex-end";

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = !!value;
  input.addEventListener("change", (e) => {
    cam[key] = e.target.checked;
    onChange({ [key]: e.target.checked });
  });
  wrap.appendChild(input);
  row.appendChild(wrap);

  return row;
}

function speedRow(labelText, key, value, cam, onChange) {
  const row = document.createElement("div");
  row.className = "viewer-3d-settings-row";

  const label = document.createElement("label");
  label.textContent = labelText;
  row.appendChild(label);

  const input = document.createElement("input");
  input.type = "range";
  input.min = "0.1";
  input.max = "3.0";
  input.step = "0.05";
  input.value = String(value);
  row.appendChild(input);

  const readout = document.createElement("span");
  readout.className = "readout";
  readout.textContent = (+value).toFixed(2);
  row.appendChild(readout);

  input.addEventListener("input", (e) => {
    const v = +e.target.value;
    cam[key] = v;
    readout.textContent = v.toFixed(2);
    onChange({ [key]: v });
  });

  return row;
}
