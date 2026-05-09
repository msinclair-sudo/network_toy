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

import { makeBlendForce }                  from "../../blend/blend.js";
import { getState, setTabConfig }          from "../state.js";

export const ID = "viewer-3d";
export const LABEL = "3D viewer";
export const DESCRIPTION = "Live blend visualisation; per-frame interpolation between basePos and aligned citation layout.";
// WebGL context budget + 3d-force-graph teardown noise → only one
// instance allowed across all slots at any time. The panel-picker
// modal filters this out when an instance already exists somewhere.
export const SINGLETON = true;

const R_GLOBAL = 60;        // matches generation.js's working half-extent

const DEFAULT_CAMERA = {
  // Speeds are 0..1 fractions of TrackballControls' native rate (1.0 native).
  // Defaults of 0.3 are ~3× slower than native for finer control on dense
  // graphs; user can dial up to 1.0 in 0.01 steps via the settings popup.
  rotateSpeed:  0.3,
  zoomSpeed:    0.3,
  panSpeed:     0.3,
  // 3d-force-graph uses TrackballControls. staticMoving=false (its default)
  // gives the camera inertia/coasting after mouse release — the "acceleration"
  // feel. We default to true (no inertia, click-and-stick) and let the user
  // re-enable smooth motion via the settings popup if they want it.
  smoothMotion: false,
};

export function mount(container, _state, config = {}, tabContext = null) {
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
  let lastSelection = null;       // tracked for re-paint without rebuild

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
      .nodeColor(nodeColour)
      .nodeOpacity(1.0)
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

  // Colour a node based on cluster + current selection state.
  // - No selection: render its native cluster colour.
  // - Selection of "cluster": dim non-selected to a faint grey,
  //   keep selected cluster at full saturation.
  // Reads getState() each call (called per node, lib-driven).
  function nodeColour(n) {
    const sel = getState().selection;
    if (!sel || sel.type !== "cluster" || sel.id == null) {
      return n.colour || "#888";
    }
    if (n.clusterId === sel.id) return n.colour || "#888";
    return "#3a3f4a";   // dimmed slate
  }

  // Re-evaluate node colours without rebuilding graphData. Cheap;
  // 3d-force-graph re-reads the colour accessor on refresh().
  function repaintSelection() {
    if (!Graph) return;
    Graph.nodeColor(nodeColour);
    if (Graph.refresh) Graph.refresh();
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

  // Persist the camera config back into our tab's config so values
  // survive a panel re-mount (data reload / panel switch). The tab
  // context is supplied at mount; without it we silently no-op
  // (e.g. a stand-alone usage outside the panel system).
  function persistCamConfig(_partial) {
    if (!tabContext) return;
    setTabConfig(tabContext.slot, tabContext.tabId, { ...cam });
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
        lastSelection = s.selection;
        return;
      }
      // Selection-only change: re-paint colours, no rebuild.
      const selChanged =
        !lastSelection ||
        lastSelection.type !== s.selection.type ||
        lastSelection.id   !== s.selection.id;
      if (selChanged) {
        lastSelection = s.selection;
        repaintSelection();
      }
    },
    destroy() {
      if (resizeObs) {
        try { resizeObs.disconnect(); } catch (_) {}
        resizeObs = null;
      }
      if (settingsRoot) settingsRoot.remove();

      // 3d-force-graph teardown is racy: an in-flight tick (from
      // TrackballControls' own update loop) can fire after
      // _destructor() removes the simulation, throwing
      // "Cannot read properties of undefined (reading 'tick')".
      // We dampen it with pauseAnimation + controls.dispose() +
      // a deferred _destructor; one stale tick still leaks through
      // on some runs. It's a 3d-force-graph internal bug and
      // doesn't affect the page's behaviour. Smoke tests filter it.
      const g = Graph;
      Graph = null;
      container.innerHTML = "";
      if (g) {
        try { g.pauseAnimation && g.pauseAnimation(); } catch (_) {}
        try {
          const c = g.controls && g.controls();
          if (c && c.dispose) c.dispose();
        } catch (_) {}
        requestAnimationFrame(() => {
          try { g._destructor && g._destructor(); } catch (_) {}
        });
      }
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
  hint.textContent = "0–1 fraction of native speed";
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
  input.min = "0";
  input.max = "1";
  input.step = "0.01";
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
