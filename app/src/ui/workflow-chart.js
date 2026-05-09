// Workflow chart — SVG DAG renderer for the pipeline.
//
// One node per layer. Input layers ([Data], [Citations]) are drawn
// with dashed strokes to distinguish them from method layers.
// Click a node → opens its modal (stub for now; wired in slice 4).
//
// State coupling:
//   state.layerStates[id]      → status dot colour
//   state.activeAlgorithm[id]  → small algorithm name under the label
//
// Layout is hand-positioned (the pipeline is fixed; auto-layout is
// overkill at this scale). One column for the main spine, plus a
// citations branch.

import { getState, subscribe } from "./state.js";

// Hand layout. y-positions are in SVG-local coords; the SVG itself
// scales width to fit the rail.
const NODES = [
  // [id, label, x, y, kind]   kind: "input" | "method"
  { id: "data",       label: "Data",          x:  90, y:  20, kind: "input"  },
  { id: "dimred",     label: "Dim reduction", x:  90, y:  80, kind: "method" },
  { id: "clustering", label: "Clustering",    x:  90, y: 140, kind: "method" },
  { id: "citations",  label: "Citations",     x:  20, y: 200, kind: "input"  },
  { id: "layout",     label: "Cit. layout",   x:  90, y: 200, kind: "method" },
  { id: "alignment",  label: "Alignment",     x:  90, y: 260, kind: "method" },
  { id: "blend",      label: "Blend",         x:  90, y: 320, kind: "method" },
];

const EDGES = [
  ["data",       "dimred"],
  ["dimred",     "clustering"],
  ["clustering", "layout"],
  ["citations",  "layout"],
  ["layout",     "alignment"],
  ["alignment",  "blend"],
];

const NODE_W = 140;
const NODE_H = 38;
const VIEWBOX_W = 180;
const VIEWBOX_H = 360;

export function mountWorkflowChart() {
  const root = document.getElementById("workflow-chart");
  if (!root) return;
  render(root);
  subscribe(() => render(root));
}

function render(root) {
  const state = getState();
  root.innerHTML = "";

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${VIEWBOX_W} ${VIEWBOX_H}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMin meet");

  // arrowhead marker
  const defs = svgEl("defs");
  const marker = svgEl("marker", {
    id: "wf-arrowhead",
    viewBox: "0 0 10 10",
    refX: "9", refY: "5",
    markerWidth: "6", markerHeight: "6",
    orient: "auto-start-reverse",
  });
  const arrowPath = svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#4a5260" });
  marker.appendChild(arrowPath);
  defs.appendChild(marker);
  svg.appendChild(defs);

  // edges
  for (const [from, to] of EDGES) {
    const a = NODES.find(n => n.id === from);
    const b = NODES.find(n => n.id === to);
    if (!a || !b) continue;
    svg.appendChild(renderEdge(a, b));
  }

  // nodes
  for (const node of NODES) {
    svg.appendChild(renderNode(node, state));
  }

  root.appendChild(svg);
}

function renderEdge(a, b) {
  const g = svgEl("g");

  const x1 = a.x + NODE_W / 2;
  const y1 = a.y + NODE_H;
  const x2 = b.x + NODE_W / 2;
  const y2 = b.y;

  // Direct path with a small mid-bend for branch edges.
  let d;
  if (Math.abs(x1 - x2) < 1) {
    d = `M ${x1} ${y1} L ${x2} ${y2 - 2}`;
  } else {
    const my = (y1 + y2) / 2;
    d = `M ${x1} ${y1} L ${x1} ${my} L ${x2} ${my} L ${x2} ${y2 - 2}`;
  }

  const path = svgEl("path", { d, class: "wf-arrow" });
  g.appendChild(path);
  return g;
}

function renderNode(node, state) {
  const g = svgEl("g", { transform: `translate(${node.x}, ${node.y})` });

  const rect = svgEl("rect", {
    width: NODE_W,
    height: NODE_H,
    class: `wf-node-rect ${node.kind === "input" ? "input" : ""}`,
  });
  rect.addEventListener("click", () => {
    console.log(`[workflow-chart] node click: ${node.id} — modal pending (slice 4/5)`);
  });
  g.appendChild(rect);

  // status dot
  const layerState = state.layerStates[node.id] || "not-run";
  const dot = svgEl("circle", {
    cx: 10,
    cy: NODE_H / 2,
    r: 4,
    class: `wf-state-dot ${stateClass(layerState)}`,
  });
  g.appendChild(dot);

  // label
  const label = svgEl("text", {
    x: NODE_W / 2 + 4,
    y: node.kind === "input" ? NODE_H / 2 : NODE_H / 2 - 6,
    class: "wf-node-label",
  });
  label.textContent = node.label;
  g.appendChild(label);

  // active algorithm (only for method nodes)
  if (node.kind === "method") {
    const algoId = state.activeAlgorithm[node.id];
    if (algoId) {
      const algoText = svgEl("text", {
        x: NODE_W / 2 + 4,
        y: NODE_H / 2 + 7,
        class: "wf-node-algo",
      });
      algoText.textContent = algoId;
      g.appendChild(algoText);
    }
  }

  return g;
}

function stateClass(layerState) {
  switch (layerState) {
    case "fresh":  return "fresh";
    case "stale":  return "stale";
    case "error":  return "error";
    default:       return "not-run";
  }
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) el.setAttribute(k, v);
  }
  return el;
}
