// Workflow chart — tree-aware SVG renderer.
//
// Phase 2 slice 2.3 of the workflow-tree-redesign. Reads from
// state.workflow (the typed branching DAG that lives in workflow.js)
// instead of the hand-positioned 7-node list this file used to ship.
//
// Self-contained module: defined inputs + outputs.
//   - Inputs: state.workflow (via workflow.js's read API) + state
//     subscriptions for re-render.
//   - Side effects: mounts an SVG under #workflow-chart; calls
//     selectStep(id) on click; opens the relevant modal for spine
//     step types via getLayerDescriptor (slice 2.5 will move this
//     into modal-as-step-creator).
//   - Auto-migration: when state.workflow is empty but the legacy
//     state slots are populated, calls migrateLegacyToWorkflowIfNeeded
//     to bootstrap a baseline linear tree before rendering. Idempotent.
//
// Layout (slice 2.3 first cut): the tree is rendered as a vertical
// spine, with non-spine children (e.g. saved ValidationRun cards
// attached to a clustering step) floated to the right at their
// parent's depth. Real branching layout (multiple siblings on the
// spine) lands in slice 2.8.

import { getState, subscribe }            from "./state.js";
import {
  getRootStep, getStepChildren, getSelectedStep, isStepStale,
  selectStep, listSteps, STEP_STATUS,
} from "./workflow.js";
import { migrateLegacyToWorkflowIfNeeded } from "./workflow-migration.js";
import { getLayerDescriptor }              from "./modals/layer-descriptors.js";

// Spine step types — the universal pipeline. Anything else attached
// to a spine card is rendered as a "side branch" to the right.
const SPINE_TYPES = new Set([
  "data", "dimred", "clustering", "citations",
  "citationLayout", "alignment", "blend",
]);

// Map step.type → existing layer-descriptor id (the chart's click
// handler opens that descriptor's modal during the transition;
// slice 2.5 replaces this with "create a new step" semantics).
const DESCRIPTOR_BY_TYPE = {
  "data":           "data",
  "dimred":         "dimred",
  "clustering":     "clustering",
  "citationLayout": "layout",
};

// Layout constants.
const NODE_W       = 200;
const NODE_H       = 40;
const SPINE_X      = 10;
const SIDE_X       = 230;        // x-offset for side-branch cards
const SIDE_W       = 180;
const SIDE_H       = 30;
const VERTICAL_GAP = 52;         // vertical distance between spine rows
const SIDE_GAP     = 6;          // vertical gap between stacked side-branch cards
const TOP_PAD      = 10;
const BOTTOM_PAD   = 12;

const SVG_NS = "http://www.w3.org/2000/svg";


export function mountWorkflowChart() {
  const root = document.getElementById("workflow-chart");
  if (!root) return;
  render(root);
  subscribe(() => render(root));
}

function render(root) {
  // Auto-migrate on every render if the workflow is empty but legacy
  // slots have data. Idempotent — no-ops after the first hit.
  migrateLegacyToWorkflowIfNeeded();

  const rootStep = getRootStep();

  // Empty-state: no tree yet. Could happen on a degenerate boot
  // (no genResult). Render an empty hint rather than a blank rail.
  if (!rootStep) {
    renderEmptyHint(root);
    return;
  }

  // Compute layout: walk the spine top-down + lay out side-branches
  // to the right at each spine node's row.
  const layout = computeLayout(rootStep);
  renderSvg(root, layout);
}

// ── layout ───────────────────────────────────────────────────────────

/**
 * Compute SVG-local positions for every step.
 *
 * Returns:
 *   {
 *     spine:    [{ step, x, y }],         // ordered top-down
 *     side:     [{ step, x, y, parentY }], // attached to a spine row
 *     edges:    [{ from: id, to: id }],
 *     viewboxW, viewboxH,
 *   }
 *
 * Layout strategy (slice 2.3 first cut):
 *   - Follow the spine: from root, prefer the first child whose type
 *     is in SPINE_TYPES; that's the next spine row.
 *   - Any other children of a spine row are "side branches" — stacked
 *     vertically to the right of the parent row.
 *   - The first non-spine child of a spine row anchors the row's side
 *     stack; subsequent side children stack downward, then we adjust
 *     the next spine row downward if the side stack overflows.
 */
function computeLayout(rootStep) {
  const spine = [];
  const side  = [];
  const edges = [];

  let curY = TOP_PAD;
  let cur  = rootStep;
  const seenIds = new Set();

  while (cur) {
    if (seenIds.has(cur.id)) break;   // cycle guard (shouldn't happen)
    seenIds.add(cur.id);

    spine.push({ step: cur, x: SPINE_X, y: curY });
    const children = getStepChildren(cur.id);

    // Non-spine children → side branches at this row.
    const sideKids = children.filter(c => !SPINE_TYPES.has(c.type));
    let sideY = curY;
    for (let i = 0; i < sideKids.length; i++) {
      const sk = sideKids[i];
      side.push({ step: sk, x: SIDE_X, y: sideY, parentY: curY });
      edges.push({ fromX: SPINE_X + NODE_W, fromY: curY + NODE_H / 2,
                   toX:   SIDE_X,           toY:   sideY + SIDE_H / 2 });
      sideY += SIDE_H + SIDE_GAP;
    }

    // Next spine row: the first child whose type is a spine type.
    const next = children.find(c => SPINE_TYPES.has(c.type)) || null;
    if (next) {
      // Push spine row down if the side stack here goes past the
      // default row height.
      const sideHeight = sideKids.length > 0
        ? (sideY - curY)   // total height of the side stack
        : 0;
      const nextY = curY + Math.max(VERTICAL_GAP, sideHeight + 12);
      edges.push({ fromX: SPINE_X + NODE_W / 2, fromY: curY + NODE_H,
                   toX:   SPINE_X + NODE_W / 2, toY:   nextY });
      curY = nextY;
      cur  = next;
    } else {
      cur = null;
    }
  }

  // Viewbox: tallest of spine bottom or last side card.
  const spineBottom = spine.length > 0
    ? spine[spine.length - 1].y + NODE_H
    : TOP_PAD + NODE_H;
  const sideBottom = side.length > 0
    ? Math.max(...side.map(s => s.y + SIDE_H))
    : 0;
  const viewboxH = Math.max(spineBottom, sideBottom) + BOTTOM_PAD;
  const viewboxW = SIDE_X + SIDE_W + 10;

  return { spine, side, edges, viewboxW, viewboxH };
}

// ── render ───────────────────────────────────────────────────────────

function renderEmptyHint(root) {
  root.innerHTML = "";
  const div = document.createElement("div");
  div.className = "wf-empty-hint";
  div.textContent = "Workflow tree appears once data is loaded.";
  root.appendChild(div);
}

function renderSvg(root, layout) {
  root.innerHTML = "";

  const svg = svgEl("svg", {
    viewBox: `0 0 ${layout.viewboxW} ${layout.viewboxH}`,
    preserveAspectRatio: "xMidYMin meet",
  });

  const defs = svgEl("defs");
  const marker = svgEl("marker", {
    id: "wf-arrowhead",
    viewBox: "0 0 10 10",
    refX: "9", refY: "5",
    markerWidth: "6", markerHeight: "6",
    orient: "auto-start-reverse",
  });
  marker.appendChild(svgEl("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#4a5260" }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Edges first (so cards draw on top).
  for (const e of layout.edges) {
    svg.appendChild(renderEdge(e));
  }

  // Spine cards.
  const selectedId = (getSelectedStep() && getSelectedStep().id) || null;
  for (const { step, x, y } of layout.spine) {
    svg.appendChild(renderCard(step, x, y, NODE_W, NODE_H, /*isSide=*/false, selectedId));
  }
  // Side-branch cards.
  for (const { step, x, y } of layout.side) {
    svg.appendChild(renderCard(step, x, y, SIDE_W, SIDE_H, /*isSide=*/true, selectedId));
  }

  root.appendChild(svg);
}

function renderEdge(e) {
  // Spine edges have fromX === toX (vertical); side edges go diagonal.
  let d;
  if (Math.abs(e.fromX - e.toX) < 1) {
    d = `M ${e.fromX} ${e.fromY} L ${e.toX} ${e.toY - 2}`;
  } else {
    // Right-angle bend so the side-edge reads cleanly against the
    // vertical spine.
    const mx = (e.fromX + e.toX) / 2;
    d = `M ${e.fromX} ${e.fromY} L ${mx} ${e.fromY} L ${mx} ${e.toY} L ${e.toX - 2} ${e.toY}`;
  }
  return svgEl("path", { d, class: "wf-arrow" });
}

function renderCard(step, x, y, w, h, isSide, selectedId) {
  const g = svgEl("g", { transform: `translate(${x}, ${y})` });

  const cls = ["wf-node-rect"];
  if (isSide)                   cls.push("side");
  if (step.id === selectedId)   cls.push("selected");
  if (isStepStale(step.id))     cls.push("stale");
  const rect = svgEl("rect", { width: w, height: h, class: cls.join(" ") });
  rect.addEventListener("click", () => onCardClick(step));
  g.appendChild(rect);

  // Status indicator: small circle. Colour reflects step.status.
  // (Spinner animation lands in slice 2.4 when jobs bind to steps.)
  const dot = svgEl("circle", {
    cx: 10,
    cy: h / 2,
    r: 4,
    class: `wf-state-dot ${statusClass(step.status)}`,
  });
  g.appendChild(dot);

  // Main label.
  const labelY = isSide ? h / 2 + 4 : h / 2 - 6;
  const label = svgEl("text", {
    x: w / 2 + (isSide ? -4 : 4),
    y: labelY,
    class: "wf-node-label",
  });
  label.textContent = truncate(step.label, isSide ? 22 : 28);
  g.appendChild(label);

  // Sub-label (algorithm summary) on spine cards only.
  if (!isSide) {
    const sub = subLabelFor(step);
    if (sub) {
      const algoText = svgEl("text", {
        x: w / 2 + 4,
        y: h / 2 + 7,
        class: "wf-node-algo",
      });
      algoText.textContent = truncate(sub, 28);
      g.appendChild(algoText);
    }
  }

  return g;
}

// ── interactions ─────────────────────────────────────────────────────

function onCardClick(step) {
  selectStep(step.id);

  // Transitional: if this step type maps to an existing layer
  // descriptor, open the modal. Slice 2.5 will replace this with
  // "create a new step" semantics. For now it preserves the current
  // UX while the rest of Phase 2 lands.
  const descriptorId = DESCRIPTOR_BY_TYPE[step.type];
  if (!descriptorId) return;
  const desc = getLayerDescriptor(descriptorId);
  if (desc && desc.openModal) {
    desc.openModal();
  }
}

// ── helpers ──────────────────────────────────────────────────────────

function statusClass(status) {
  switch (status) {
    case STEP_STATUS.DONE:      return "fresh";
    case STEP_STATUS.RUNNING:   return "running";
    case STEP_STATUS.FAILED:    return "error";
    case STEP_STATUS.CANCELLED: return "cancelled";
    case STEP_STATUS.PENDING:   return "pending";
    default:                    return "not-run";
  }
}

function subLabelFor(step) {
  // Provide a small algorithm-summary line for spine cards. Defaults
  // to the step's params method when present.
  const p = step.params || {};
  if (step.type === "data") {
    return p.mode || (getState().dataSource && getState().dataSource.mode) || null;
  }
  if (step.type === "dimred") {
    const cs = p.compression && p.compression.method;
    const vs = p.viz         && p.viz.method;
    if (cs === "identity" && vs === "identity") return "—";
    return `cluster: ${cs || "?"} · viz: ${vs || "?"}`;
  }
  if (step.type === "clustering") {
    const lvls = (p.levels || []).length;
    return lvls > 1 ? `${p.method || "?"} · ${lvls} levels` : (p.method || null);
  }
  if (step.type === "citations") {
    const r = step.result && step.result.citationResult;
    const n = r && r.citations ? r.citations.length : 0;
    return n > 0 ? `${n} edges` : null;
  }
  if (step.type === "citationLayout") return p.method || null;
  if (step.type === "alignment")      return "match-RMS";
  if (step.type === "blend")          return `α = ${(p.alpha || 0).toFixed(2)}`;
  return null;
}

function truncate(s, max) {
  if (!s) return "";
  s = String(s);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v != null) el.setAttribute(k, v);
  }
  return el;
}
