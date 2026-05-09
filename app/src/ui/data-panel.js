// Data info panel — top of the left rail.
//
// Two modes (per doc/ui.md §4.1):
//   "toy"  — inline editors for fast iteration + Generate button.
//   "real" — read-only stats about the loaded dataset.
//
// Mode is driven by state.dataSource.mode.

import { getState, subscribe, setToyParam, setLayerState } from "./state.js";

export function mountDataPanel() {
  const root = document.getElementById("data-panel");
  if (!root) return;
  render(root);

  subscribe((state) => {
    // Re-render on mode change. Inline-input changes don't need
    // a full re-render (we trust the DOM).
    if (root.dataset.mode !== state.dataSource.mode) {
      render(root);
    }
  });
}

function render(root) {
  const state = getState();
  root.dataset.mode = state.dataSource.mode;
  root.innerHTML = "";

  if (state.dataSource.mode === "toy") {
    root.appendChild(renderToyMode(state));
  } else {
    root.appendChild(renderRealMode(state));
  }
}

function renderToyMode(state) {
  const cfg = state.dataSource.config;
  const wrap = document.createElement("div");
  wrap.appendChild(title("Toy data"));

  wrap.appendChild(numberRow("Seed",    "seed",       cfg.seed));
  wrap.appendChild(numberRow("Nodes",   "nodeCount",  cfg.nodeCount));
  wrap.appendChild(numberRow("Origins", "origins",    cfg.origins));
  wrap.appendChild(rangeRow ("Spread",  "spread",     cfg.spread,    0.1, 3.0, 0.05));
  wrap.appendChild(rangeRow ("Density", "density",    cfg.density,   0.0, 1.0, 0.01));
  wrap.appendChild(rangeRow ("Intra",   "intraRate",  cfg.intraRate, 0.0, 1.0, 0.01));
  wrap.appendChild(rangeRow ("Cross",   "crossRate",  cfg.crossRate, 0.0, 1.0, 0.01));

  const actions = document.createElement("div");
  actions.className = "data-panel-actions";

  const genBtn = document.createElement("button");
  genBtn.textContent = "Generate ▶";
  genBtn.title = "Re-run Layer 1 (generation) and cascade.";
  genBtn.addEventListener("click", () => {
    // Engine wiring in slice 2; for now mark layers stale and log.
    setLayerState("data", "fresh");
    setLayerState("dimred", "stale");
    setLayerState("clustering", "stale");
    setLayerState("citations", "stale");
    setLayerState("layout", "stale");
    setLayerState("alignment", "stale");
    setLayerState("blend", "stale");
    console.log("[data-panel] Generate ▶ — engine wiring pending (slice 2)");
  });
  actions.appendChild(genBtn);

  const more = document.createElement("a");
  more.href = "#";
  more.textContent = "More…";
  more.title = "Open full generation modal (slice 5)";
  more.addEventListener("click", (e) => {
    e.preventDefault();
    console.log("[data-panel] More… — modal pending (slice 5)");
  });
  actions.appendChild(more);

  wrap.appendChild(actions);
  return wrap;
}

function renderRealMode(state) {
  const cfg = state.dataSource.config;
  const wrap = document.createElement("div");
  wrap.appendChild(title(cfg.datasetName || "(no dataset loaded)"));

  if (cfg.paperCount != null) {
    wrap.appendChild(stat("Papers",       formatInt(cfg.paperCount)));
    wrap.appendChild(stat("Hybrid edges", formatInt(cfg.edgeCount)));
    wrap.appendChild(stat("Embedding",    cfg.embeddingDim ? `${cfg.embeddingDim}-d` : "—"));
  } else {
    const hint = document.createElement("div");
    hint.style.color = "var(--text-faint)";
    hint.style.fontSize = "11px";
    hint.style.marginTop = "8px";
    hint.textContent = "No dataset loaded. Use Data ▾ → Load real dataset…";
    wrap.appendChild(hint);
  }

  const actions = document.createElement("div");
  actions.className = "data-panel-actions";
  actions.style.marginTop = "10px";

  const loadLink = document.createElement("a");
  loadLink.href = "#";
  loadLink.textContent = "Load different…";
  loadLink.addEventListener("click", (e) => {
    e.preventDefault();
    console.log("[data-panel] Load different… — modal pending (slice 5)");
  });
  actions.appendChild(loadLink);
  wrap.appendChild(actions);

  return wrap;
}

/* ── small builders ─────────────────────────────────────────────────── */

function title(text) {
  const el = document.createElement("div");
  el.className = "data-panel-title";
  const dot = document.createElement("span");
  dot.className = "dot";
  el.appendChild(dot);
  const span = document.createElement("span");
  span.textContent = text;
  el.appendChild(span);
  return el;
}

function numberRow(labelText, key, value) {
  const row = document.createElement("div");
  row.className = "data-panel-row";

  const label = document.createElement("label");
  label.textContent = labelText;
  row.appendChild(label);

  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.addEventListener("change", (e) => {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v)) setToyParam(key, v);
  });
  row.appendChild(input);

  return row;
}

function rangeRow(labelText, key, value, min, max, step) {
  const row = document.createElement("div");
  row.className = "data-panel-row";
  row.style.gridTemplateColumns = "70px 1fr 36px";

  const label = document.createElement("label");
  label.textContent = labelText;
  row.appendChild(label);

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  row.appendChild(input);

  const readout = document.createElement("span");
  readout.className = "value-readout";
  readout.textContent = formatNum(value);
  row.appendChild(readout);

  input.addEventListener("input", (e) => {
    const v = parseFloat(e.target.value);
    readout.textContent = formatNum(v);
    setToyParam(key, v);
  });

  return row;
}

function stat(labelText, valueText) {
  const row = document.createElement("div");
  row.className = "data-panel-stat";
  const lab = document.createElement("label"); lab.textContent = labelText;
  const val = document.createElement("span");  val.textContent  = valueText;
  row.appendChild(lab);
  row.appendChild(val);
  return row;
}

function formatNum(v) {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(1);
  return v.toFixed(2);
}

function formatInt(n) {
  return Number(n).toLocaleString("en-US");
}
