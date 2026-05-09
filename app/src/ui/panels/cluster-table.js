// Cluster table panel.
//
// Reads state.clusterResult.clusters and renders a sortable table.
// Clicking a row sets state.selection = { type: "cluster", id }; the
// 3D viewer subscribes to selection and highlights the chosen cluster.
//
// Re-renders only when clusterResult changes (compared by reference;
// engine.recluster() builds a new array). Selection-only changes
// don't rebuild the rows — they just re-paint the highlighted row.

import { getState, setSelection } from "../state.js";

export const ID = "cluster-table";
export const LABEL = "Cluster table";
export const DESCRIPTION = "One row per cluster: id, colour, count, spread, stability. Click to select.";

const COLUMNS = [
  { key: "colour",    label: "",        kind: "colour",  sortable: false },
  { key: "id",        label: "id",      kind: "int",     sortable: true  },
  { key: "count",     label: "count",   kind: "int",     sortable: true  },
  { key: "spread",    label: "spread",  kind: "float",   sortable: true  },
  { key: "stability", label: "stab.",   kind: "float",   sortable: true  },
];

export function mount(container, _state, _config = {}) {
  container.innerHTML = "";
  const root = document.createElement("div");
  root.className = "cluster-table-root";
  container.appendChild(root);

  const empty = document.createElement("div");
  empty.className = "cluster-table-empty";
  empty.textContent = "no clusters yet — click Generate ▶";
  root.appendChild(empty);

  const wrap = document.createElement("div");
  wrap.className = "cluster-table-scroll";
  root.appendChild(wrap);

  const table = document.createElement("table");
  table.className = "cluster-table";
  wrap.appendChild(table);

  const thead = document.createElement("thead");
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  const footer = document.createElement("div");
  footer.className = "cluster-table-footer";
  root.appendChild(footer);

  let lastClusterResult = null;
  let sortKey = "count";
  let sortDir = "desc";        // "asc" | "desc"

  function renderHeader() {
    thead.innerHTML = "";
    const tr = document.createElement("tr");
    for (const col of COLUMNS) {
      const th = document.createElement("th");
      th.textContent = col.label;
      th.className = "cluster-table-th " + (col.sortable ? "sortable" : "");
      if (col.sortable && col.key === sortKey) {
        th.classList.add("sorted-" + sortDir);
        const arrow = document.createElement("span");
        arrow.className = "sort-indicator";
        arrow.textContent = sortDir === "asc" ? "▲" : "▼";
        th.appendChild(arrow);
      }
      if (col.sortable) {
        th.addEventListener("click", () => {
          if (sortKey === col.key) {
            sortDir = sortDir === "asc" ? "desc" : "asc";
          } else {
            sortKey = col.key;
            // Default direction differs per column kind.
            sortDir = col.kind === "int" || col.kind === "float" ? "desc" : "asc";
          }
          renderHeader();
          renderRows();
        });
      }
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }

  function renderRows() {
    const s = getState();
    const cr = s.clusterResult;
    tbody.innerHTML = "";

    if (!cr || !cr.clusters || cr.clusters.length === 0) {
      empty.style.display = "block";
      wrap.style.display = "none";
      footer.textContent = "";
      return;
    }
    empty.style.display = "none";
    wrap.style.display = "block";

    const rows = cr.clusters.slice();
    rows.sort((a, b) => compareBy(a, b, sortKey, sortDir));

    const selId = s.selection && s.selection.type === "cluster" ? s.selection.id : null;

    for (const c of rows) {
      const tr = document.createElement("tr");
      tr.className = "cluster-table-row";
      tr.dataset.clusterId = String(c.id);
      if (c.id === selId) tr.classList.add("selected");

      tr.appendChild(td(swatch(c.colour),  "cluster-table-colour"));
      tr.appendChild(td(c.id,              "cluster-table-id"));
      tr.appendChild(td(c.count,           "cluster-table-count"));
      tr.appendChild(td(formatNum(c.spread), "cluster-table-spread"));
      tr.appendChild(td(formatStab(c.stability), "cluster-table-stab"));

      tr.addEventListener("click", () => {
        const cur = getState().selection;
        if (cur && cur.type === "cluster" && cur.id === c.id) {
          setSelection({ type: null, id: null });
        } else {
          setSelection({ type: "cluster", id: c.id });
        }
      });

      tbody.appendChild(tr);
    }

    footer.textContent = `${cr.clusters.length} cluster${cr.clusters.length === 1 ? "" : "s"}`;
  }

  function paintSelection() {
    const s = getState();
    const selId = s.selection && s.selection.type === "cluster" ? s.selection.id : null;
    for (const tr of tbody.querySelectorAll(".cluster-table-row")) {
      const id = +tr.dataset.clusterId;
      tr.classList.toggle("selected", id === selId);
    }
  }

  // Initial paint.
  renderHeader();
  renderRows();
  lastClusterResult = getState().clusterResult;

  return {
    update(s) {
      if (s.clusterResult !== lastClusterResult) {
        lastClusterResult = s.clusterResult;
        renderRows();
      } else {
        // selection-only update: just re-paint the highlight.
        paintSelection();
      }
    },
    destroy() {
      container.innerHTML = "";
    },
  };
}

/* ── helpers ────────────────────────────────────────────────────────── */

function compareBy(a, b, key, dir) {
  let av = a[key], bv = b[key];
  // NaN sorts to bottom regardless of direction.
  const aNaN = Number.isNaN(av), bNaN = Number.isNaN(bv);
  if (aNaN && bNaN) return 0;
  if (aNaN) return 1;
  if (bNaN) return -1;
  if (av < bv) return dir === "asc" ? -1 : 1;
  if (av > bv) return dir === "asc" ?  1 : -1;
  return 0;
}

function td(content, cls) {
  const el = document.createElement("td");
  if (cls) el.className = cls;
  if (content instanceof Node) el.appendChild(content);
  else el.textContent = content == null ? "" : String(content);
  return el;
}

function swatch(colour) {
  const el = document.createElement("span");
  el.className = "colour-swatch";
  el.style.background = colour || "#888";
  return el;
}

function formatNum(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(1);
  return v.toFixed(2);
}

function formatStab(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(2);
}
