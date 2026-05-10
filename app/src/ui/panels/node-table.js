// Node table — the legend for whatever's currently colouring the
// 3D viewer.
//
// Source modes:
//   "auto"            — follows the active 3D viewer's colourMode
//   "cluster:N"       — clusters at level N (one row per cluster)
//   "cluster:finest"  — last level
//   "origin"          — generator origins (one row per Gaussian centre)
//   "inDeg"           — top-N nodes by citation in-degree
//   "t"               — 10 time bins
//
// Each mode emits {columns, rows} via a small builder. The renderer
// is generic — sortable headers, colour-swatch cells, click-to-select
// row handlers. Selection emits a typed object that viewer-3d uses
// for dimming:
//
//   {type: "cluster", level: N, id: cid}
//   {type: "origin",  id: oid}
//   {type: "node",    id: nodeId}
//   {type: "tBin",    binIdx: i}        (no viewer effect yet)

import { getState, setSelection, setTabConfig } from "../state.js";

export const ID = "node-table";
export const LABEL = "Node table";
export const DESCRIPTION = "Legend for the active colouring. Set Source to Auto to follow the 3D viewer, or pin to a specific source (cluster level, origin, in-degree, time).";

const TOP_N_INDEG = 50;
const T_BINS      = 10;

export function mount(container, _state, config = {}, tabContext = null) {
  container.innerHTML = "";

  // Working source — committed to tab config when changed.
  let source = config.source || "auto";

  // Sort state local to this panel; reset on source change.
  let sortKey = null;
  let sortDir = "desc";

  const root = document.createElement("div");
  root.className = "node-table-root";
  container.appendChild(root);

  // ── header bar ──────────────────────────────────────────────────
  const headBar = document.createElement("div");
  headBar.className = "node-table-headbar";

  const sourceLabel = document.createElement("label");
  sourceLabel.className = "node-table-headbar-label";
  sourceLabel.textContent = "Source:";
  headBar.appendChild(sourceLabel);

  const sourceSelect = document.createElement("select");
  sourceSelect.className = "node-table-source-select";
  headBar.appendChild(sourceSelect);

  const statusEl = document.createElement("span");
  statusEl.className = "node-table-status";
  headBar.appendChild(statusEl);

  root.appendChild(headBar);

  // ── empty state hint ────────────────────────────────────────────
  const empty = document.createElement("div");
  empty.className = "node-table-empty";
  root.appendChild(empty);

  // ── scrollable table ────────────────────────────────────────────
  const wrap = document.createElement("div");
  wrap.className = "node-table-scroll";
  root.appendChild(wrap);

  const table = document.createElement("table");
  table.className = "node-table";
  wrap.appendChild(table);
  const thead = document.createElement("thead");
  table.appendChild(thead);
  const tbody = document.createElement("tbody");
  table.appendChild(tbody);

  const footer = document.createElement("div");
  footer.className = "node-table-footer";
  root.appendChild(footer);

  let lastSourceKey = null;
  let lastEngineRev = -1;
  let lastViewerMode = null;

  sourceSelect.addEventListener("change", () => {
    source = sourceSelect.value;
    if (tabContext) setTabConfig(tabContext.slot, tabContext.tabId, { source });
    sortKey = null;
    fullRender();
  });

  function fullRender() {
    const s = getState();
    rebuildSourceOptions(s);
    const effective = effectiveSource(s, source);
    const data = buildTableData(s, effective);
    statusEl.textContent = data.title || "";
    if (lastSourceKey !== effective) {
      lastSourceKey = effective;
      sortKey = data.defaultSort ? data.defaultSort.key : null;
      sortDir = data.defaultSort ? data.defaultSort.dir : "desc";
    }
    renderHeader(data.columns);
    renderRows(data.columns, data.rows, data.selectionKey);
    footer.textContent = `${data.rows.length} ${data.unitLabel || "rows"}`;
  }

  function rebuildSourceOptions(s) {
    const opts = sourceOptionsFor(s);
    sourceSelect.innerHTML = "";
    let matched = false;
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === source) {
        opt.selected = true;
        matched = true;
      }
      sourceSelect.appendChild(opt);
    }
    if (!matched && opts.length > 0) {
      const auto = opts.find(o => o.value === "auto");
      source = auto ? auto.value : opts[0].value;
      sourceSelect.value = source;
      if (tabContext) setTabConfig(tabContext.slot, tabContext.tabId, { source });
    }
  }

  function renderHeader(columns) {
    thead.innerHTML = "";
    const tr = document.createElement("tr");
    for (const col of columns) {
      const th = document.createElement("th");
      th.className = "node-table-th " + (col.sortable ? "sortable" : "");
      th.textContent = col.label;
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
            sortDir = (col.kind === "int" || col.kind === "float") ? "desc" : "asc";
          }
          fullRender();
        });
      }
      tr.appendChild(th);
    }
    thead.appendChild(tr);
  }

  function renderRows(columns, rows, selectionKey) {
    tbody.innerHTML = "";
    if (rows.length === 0) {
      empty.style.display = "block";
      empty.textContent = "Nothing to show for this source yet.";
      wrap.style.display = "none";
      return;
    }
    empty.style.display = "none";
    wrap.style.display = "block";

    const sorted = sortKey != null
      ? rows.slice().sort((a, b) => compareBy(a, b, sortKey, sortDir))
      : rows;
    const sel = getState().selection;

    for (const row of sorted) {
      const tr = document.createElement("tr");
      tr.className = "node-table-row";
      tr.dataset.rowKey = row._key;
      const isSel = sel && selectionKey && selectionKey(row, sel);
      if (isSel) tr.classList.add("selected");

      for (const col of columns) {
        const td = document.createElement("td");
        td.className = `node-table-cell node-table-cell-${col.kind}`;
        if (col.kind === "colour") {
          const sw = document.createElement("span");
          sw.className = "colour-swatch";
          sw.style.background = row[col.key] || "#888";
          td.appendChild(sw);
        } else {
          td.textContent = formatCell(row[col.key], col.kind);
        }
        tr.appendChild(td);
      }

      tr.addEventListener("click", () => {
        if (!row._select) return;
        const cur = getState().selection;
        const proposed = row._select();
        if (cur && sameSelection(cur, proposed)) {
          setSelection({ type: null, id: null });
        } else {
          setSelection(proposed);
        }
      });

      tbody.appendChild(tr);
    }
  }

  // Initial.
  fullRender();

  return {
    update(s) {
      const viewerMode = activeViewerColourMode(s);
      if (s.engineRevision !== lastEngineRev || viewerMode !== lastViewerMode) {
        lastEngineRev = s.engineRevision;
        lastViewerMode = viewerMode;
        fullRender();
      } else {
        // Selection-only change: cheap repaint of row highlight.
        repaintSelectionOnly();
      }
    },
    destroy() {
      container.innerHTML = "";
    },
  };

  function repaintSelectionOnly() {
    const s = getState();
    const data = buildTableData(s, effectiveSource(s, source));
    const selectionKey = data.selectionKey;
    const sel = s.selection;
    for (const tr of tbody.querySelectorAll(".node-table-row")) {
      const matched = data.rows.find(r => r._key === tr.dataset.rowKey);
      const isSel = sel && selectionKey && matched && selectionKey(matched, sel);
      tr.classList.toggle("selected", !!isSel);
    }
  }
}

/* ── source resolution ────────────────────────────────────────────── */

function effectiveSource(s, source) {
  if (source !== "auto") return source;
  return activeViewerColourMode(s) || "cluster:finest";
}

function activeViewerColourMode(s) {
  for (const slot of Object.keys(s.panels)) {
    for (const tab of s.panels[slot].tabs) {
      if (tab.type === "viewer-3d") {
        return (tab.config && tab.config.colourMode) || "cluster:finest";
      }
    }
  }
  return null;
}

function sourceOptionsFor(s) {
  const opts = [];
  opts.push({ value: "auto", label: "Auto (follow 3D viewer)" });
  const levels = s.clusterLevels || [];
  if (levels.length > 0) {
    opts.push({ value: "cluster:finest", label: `Cluster (finest, L${levels.length - 1})` });
    for (let i = 0; i < levels.length; i++) {
      opts.push({
        value: `cluster:${i}`,
        label: levels.length > 1 ? `Cluster (level ${i})` : "Cluster",
      });
    }
  }
  if (s.bridgeAnalysis) {
    opts.push({ value: "bridge", label: "Bridge clusters" });
  }
  if (s.genResult && s.genResult.origins) {
    opts.push({ value: "origin", label: "Origin (generator label)" });
  }
  opts.push({ value: "t", label: "Time (t)" });
  if (s.citationResult) {
    opts.push({ value: "inDeg", label: "Citation in-degree" });
  }
  return opts;
}

/* ── per-source row builders ──────────────────────────────────────── */

function buildTableData(s, source) {
  if (source && source.startsWith("cluster")) return clusterRows(s, source);
  if (source === "bridge") return bridgeRows(s);
  if (source === "origin") return originRows(s);
  if (source === "inDeg")  return inDegRows(s);
  if (source === "t")      return timeBinRows(s);
  return { columns: [], rows: [], unitLabel: "rows", title: "" };
}

function clusterRows(s, source) {
  const levels = s.clusterLevels || [];
  if (levels.length === 0) {
    return { columns: [], rows: [], unitLabel: "clusters", title: "no clusters yet" };
  }
  let levelIdx;
  if (source === "cluster:finest") levelIdx = levels.length - 1;
  else levelIdx = parseInt(source.slice(8), 10);
  if (!Number.isFinite(levelIdx) || levelIdx < 0 || levelIdx >= levels.length) {
    levelIdx = levels.length - 1;
  }
  const cr = levels[levelIdx].clusterResult;
  const rows = cr.clusters.map(c => ({
    _key:    `cluster:${levelIdx}:${c.id}`,
    _select: () => ({ type: "cluster", level: levelIdx, id: c.id }),
    colour:  c.colour,
    id:      c.id,
    count:   c.count,
    spread:  c.spread,
    stab:    c.stability,
  }));
  return {
    title:      `level ${levelIdx} · ${cr.method}`,
    unitLabel:  rows.length === 1 ? "cluster" : "clusters",
    columns: [
      { key: "colour", label: "",       kind: "colour", sortable: false },
      { key: "id",     label: "id",     kind: "int",    sortable: true  },
      { key: "count",  label: "count",  kind: "int",    sortable: true  },
      { key: "spread", label: "spread", kind: "float",  sortable: true  },
      { key: "stab",   label: "stab.",  kind: "float",  sortable: true  },
    ],
    rows,
    defaultSort: { key: "count", dir: "desc" },
    selectionKey: (row, sel) =>
      sel.type === "cluster" && sel.level === levelIdx && sel.id === row.id,
  };
}

function bridgeRows(s) {
  const ba = s.bridgeAnalysis;
  const levels = s.clusterLevels || [];
  if (!ba || levels.length < 2) {
    return {
      columns: [], rows: [], unitLabel: "bridges",
      title: "needs at least two clustering levels",
    };
  }
  const fine   = levels[ba.fineLevel].clusterResult;
  const coarse = levels[ba.coarseLevel].clusterResult;

  const rows = ba.perCluster
    .filter(p => p.isBridge)
    .map(p => {
      const fineCluster = fine.clusters[p.fineId];
      const dominantCluster = p.dominantCoarseId >= 0
        ? coarse.clusters[p.dominantCoarseId]
        : null;
      const secondary = p.coarseShares[1];
      return {
        _key:    `bridge:${p.fineId}`,
        // Selecting a bridge row selects the fine cluster — re-uses
        // the existing cluster-level dimming logic in viewer-3d.
        _select: () => ({ type: "cluster", level: ba.fineLevel, id: p.fineId }),
        // Show the fine cluster's own colour as the swatch (matches
        // what cluster:finest mode paints), so the row reads "this
        // is the fine cluster N that bridges...".
        colour:    fineCluster ? fineCluster.colour : "#888",
        id:        p.fineId,
        count:     p.memberCount,
        span:      p.spanCount,
        dom:       p.dominantCoarseId,
        domPct:    p.dominantFraction * 100,
        sec:       secondary ? secondary.id : null,
        secPct:    secondary ? secondary.fraction * 100 : null,
      };
    });

  return {
    title:     `${ba.bridgeCount} bridge${ba.bridgeCount === 1 ? "" : "s"} · L${ba.coarseLevel}→L${ba.fineLevel}`,
    unitLabel: rows.length === 1 ? "bridge" : "bridges",
    columns: [
      { key: "colour", label: "",        kind: "colour", sortable: false },
      { key: "id",     label: "fine id", kind: "int",    sortable: true  },
      { key: "count",  label: "count",   kind: "int",    sortable: true  },
      { key: "span",   label: "span",    kind: "int",    sortable: true  },
      { key: "dom",    label: "dom",     kind: "int",    sortable: true  },
      { key: "domPct", label: "dom %",   kind: "float",  sortable: true  },
      { key: "sec",    label: "2nd",     kind: "int",    sortable: true  },
      { key: "secPct", label: "2nd %",   kind: "float",  sortable: true  },
    ],
    rows,
    defaultSort: { key: "count", dir: "desc" },
    selectionKey: (row, sel) =>
      sel.type === "cluster" && sel.level === ba.fineLevel && sel.id === row.id,
  };
}

function originRows(s) {
  const origins = s.genResult && s.genResult.origins;
  const nodes   = s.genResult && s.genResult.nodes;
  if (!origins || !nodes) {
    return { columns: [], rows: [], unitLabel: "origins", title: "no data" };
  }
  const counts = new Array(origins.length).fill(0);
  for (const n of nodes) counts[n.originId]++;

  const rows = origins.map((o, idx) => {
    const sx = o.spread[0], sy = o.spread[1], sz = o.spread[2];
    const rmsSpread = Math.sqrt((sx*sx + sy*sy + sz*sz) / 3);
    return {
      _key:    `origin:${o.id}`,
      _select: () => ({ type: "origin", id: o.id }),
      colour:  o.colour,
      id:      o.id,
      count:   counts[idx] || 0,
      spread:  rmsSpread,
      cx:      o.centre[0],
      cy:      o.centre[1],
      cz:      o.centre[2],
    };
  });
  return {
    title:     `${origins.length} origin${origins.length === 1 ? "" : "s"}`,
    unitLabel: rows.length === 1 ? "origin" : "origins",
    columns: [
      { key: "colour", label: "",       kind: "colour", sortable: false },
      { key: "id",     label: "id",     kind: "int",    sortable: true  },
      { key: "count",  label: "count",  kind: "int",    sortable: true  },
      { key: "spread", label: "spread", kind: "float",  sortable: true  },
      { key: "cx",     label: "cx",     kind: "float",  sortable: true  },
      { key: "cy",     label: "cy",     kind: "float",  sortable: true  },
      { key: "cz",     label: "cz",     kind: "float",  sortable: true  },
    ],
    rows,
    defaultSort: { key: "count", dir: "desc" },
    selectionKey: (row, sel) => sel.type === "origin" && sel.id === row.id,
  };
}

function inDegRows(s) {
  const cit   = s.citationResult;
  const nodes = s.genResult && s.genResult.nodes;
  if (!cit || !cit.inDeg || !nodes) {
    return { columns: [], rows: [], unitLabel: "nodes", title: "no citation graph" };
  }
  const cl = s.clusterResult;
  const all = [];
  for (let i = 0; i < nodes.length; i++) {
    const cid = cl ? cl.nodeCluster[i] : -1;
    const cluster = (cl && cid >= 0) ? cl.clusters[cid] : null;
    all.push({
      _key:    `node:${i}`,
      _select: () => ({ type: "node", id: i }),
      colour:  cluster ? cluster.colour : "#888",
      id:      i,
      inDeg:   cit.inDeg[i],
      t:       nodes[i].t,
      cluster: cid,
    });
  }
  all.sort((a, b) => b.inDeg - a.inDeg);
  const rows = all.slice(0, TOP_N_INDEG);
  return {
    title:     `top ${rows.length} of ${nodes.length} by in-degree`,
    unitLabel: "nodes",
    columns: [
      { key: "colour",  label: "",        kind: "colour", sortable: false },
      { key: "id",      label: "id",      kind: "int",    sortable: true  },
      { key: "inDeg",   label: "in-deg",  kind: "int",    sortable: true  },
      { key: "t",       label: "t",       kind: "float",  sortable: true  },
      { key: "cluster", label: "cluster", kind: "int",    sortable: true  },
    ],
    rows,
    defaultSort: { key: "inDeg", dir: "desc" },
    selectionKey: (row, sel) => sel.type === "node" && sel.id === row.id,
  };
}

function timeBinRows(s) {
  const nodes = s.genResult && s.genResult.nodes;
  if (!nodes) {
    return { columns: [], rows: [], unitLabel: "bins", title: "no data" };
  }
  const counts = new Array(T_BINS).fill(0);
  for (const n of nodes) {
    let b = Math.floor(n.t * T_BINS);
    if (b >= T_BINS) b = T_BINS - 1;
    if (b < 0) b = 0;
    counts[b]++;
  }
  const rows = counts.map((cnt, i) => {
    const lo  = i / T_BINS;
    const hi  = (i + 1) / T_BINS;
    const mid = (lo + hi) / 2;
    return {
      _key:    `tBin:${i}`,
      _select: () => ({ type: "tBin", binIdx: i }),
      colour:  tColour(mid),
      bin:     i,
      range:   `${lo.toFixed(1)}–${hi.toFixed(1)}`,
      mid,
      count:   cnt,
    };
  });
  return {
    title:     `${T_BINS} bins of t`,
    unitLabel: "bins",
    columns: [
      { key: "colour", label: "",       kind: "colour", sortable: false },
      { key: "bin",    label: "bin",    kind: "int",    sortable: true  },
      { key: "range",  label: "range",  kind: "text",   sortable: false },
      { key: "mid",    label: "mid t",  kind: "float",  sortable: true  },
      { key: "count",  label: "count",  kind: "int",    sortable: true  },
    ],
    rows,
    defaultSort: { key: "bin", dir: "asc" },
    selectionKey: (row, sel) => sel.type === "tBin" && sel.binIdx === row.bin,
  };
}

/* ── helpers ────────────────────────────────────────────────────────── */

function tColour(t) {
  // Mirrors viewer-3d's gradient so the legend reads as the actual rendering.
  const stops = [
    [0.00, [97, 175, 239]],
    [0.50, [191, 188, 168]],
    [1.00, [242, 142, 43]],
  ];
  const v = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (v - t0) / Math.max(1e-9, t1 - t0);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * f);
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  return "#888";
}

function compareBy(a, b, key, dir) {
  let av = a[key], bv = b[key];
  const aNaN = Number.isNaN(av), bNaN = Number.isNaN(bv);
  if (aNaN && bNaN) return 0;
  if (aNaN) return 1;
  if (bNaN) return -1;
  if (av == null && bv == null) return 0;
  if (av == null) return 1;
  if (bv == null) return -1;
  if (av < bv) return dir === "asc" ? -1 : 1;
  if (av > bv) return dir === "asc" ?  1 : -1;
  return 0;
}

function formatCell(value, kind) {
  if (value == null) return "—";
  if (kind === "int") {
    if (!Number.isFinite(value)) return "—";
    return String(Math.round(value));
  }
  if (kind === "float") {
    if (!Number.isFinite(value)) return "—";
    if (Math.abs(value) >= 100) return value.toFixed(0);
    if (Math.abs(value) >= 10)  return value.toFixed(1);
    return value.toFixed(2);
  }
  return String(value);
}

function sameSelection(a, b) {
  if (!a || !b) return false;
  if (a.type !== b.type) return false;
  if (a.type === "cluster") return a.level === b.level && a.id === b.id;
  if (a.type === "origin")  return a.id === b.id;
  if (a.type === "node")    return a.id === b.id;
  if (a.type === "tBin")    return a.binIdx === b.binIdx;
  return false;
}
