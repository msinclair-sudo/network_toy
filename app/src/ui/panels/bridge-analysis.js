// Panel: bridge analysis.
//
// Lifts the node-table's "bridge" source into a standalone panel so
// the user can read the bridge story alongside the viewers without
// sacrificing the node-table's cluster-legend role. The two pinnable
// panels can sit side-by-side: node-table coloured by cluster,
// bridge-analysis panel showing which fine clusters bridge ≥ 2
// coarser parents.
//
// Reads from state.bridgeAnalysis (Layer 2.5 derivation; null when
// fewer than two clustering levels exist). The fine/coarse level
// pair is taken from state.bridgeConfig; selector at the top lets
// the user change it (triggers recomputeBridgeAnalysis()).
//
// Clicking a row selects that cluster in the viewers (via
// setSelection). The current selection is highlighted in the table.

import { getState, subscribe, setSelection, setBridgeConfig } from "../state.js";
import { recomputeBridgeAnalysis }                            from "../engine.js";

export const ID          = "bridge-analysis";
export const LABEL       = "Bridge analysis";
export const DESCRIPTION = "Fine clusters that span ≥2 coarser parents. Surfaces multi-level boundary structure. Pick the (fine, coarse) level pair to inspect.";
export const SINGLETON   = true;

export function mount(container, _state, _config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-bridge";
  container.appendChild(wrap);

  function render() {
    wrap.innerHTML = "";
    const s = getState();
    const levels = s.clusterLevels || [];
    const ba = s.bridgeAnalysis;

    // ── Header (title + pair selector) ──
    const header = document.createElement("div");
    header.className = "panel-bridge-header";

    const title = document.createElement("div");
    title.className = "panel-bridge-title";
    title.textContent = "Bridge analysis";
    header.appendChild(title);

    if (levels.length < 2) {
      const empty = document.createElement("div");
      empty.className = "panel-bridge-empty";
      empty.textContent = "Bridge analysis needs at least two clustering levels. Add a second level in the Clustering modal → Configure → + Add level.";
      wrap.appendChild(header);
      wrap.appendChild(empty);
      return;
    }
    if (!ba) {
      const empty = document.createElement("div");
      empty.className = "panel-bridge-empty";
      empty.textContent = "Bridge analysis not yet computed.";
      wrap.appendChild(header);
      wrap.appendChild(empty);
      return;
    }

    // Pair selector.
    const pairBar = document.createElement("div");
    pairBar.className = "panel-bridge-pairbar";
    pairBar.appendChild(makeLabel("Fine:"));
    const fineSelect = makePairSelect();
    for (let i = 1; i < levels.length; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `L${i}`;
      if (i === ba.fineLevel) opt.selected = true;
      fineSelect.appendChild(opt);
    }
    fineSelect.addEventListener("change", () => {
      const fine = parseInt(fineSelect.value, 10);
      const curCoarse = ba.coarseLevel;
      const coarse = (Number.isInteger(curCoarse) && curCoarse < fine) ? curCoarse : fine - 1;
      setBridgeConfig({ fineLevel: fine, coarseLevel: coarse });
      recomputeBridgeAnalysis();
    });
    pairBar.appendChild(fineSelect);

    pairBar.appendChild(makeLabel("Coarse:"));
    const coarseSelect = makePairSelect();
    for (let j = 0; j < ba.fineLevel; j++) {
      const opt = document.createElement("option");
      opt.value = String(j);
      opt.textContent = `L${j}`;
      if (j === ba.coarseLevel) opt.selected = true;
      coarseSelect.appendChild(opt);
    }
    coarseSelect.addEventListener("change", () => {
      setBridgeConfig({ coarseLevel: parseInt(coarseSelect.value, 10) });
      recomputeBridgeAnalysis();
    });
    pairBar.appendChild(coarseSelect);

    header.appendChild(pairBar);
    wrap.appendChild(header);

    // Summary line.
    const summary = document.createElement("div");
    summary.className = "panel-bridge-summary";
    summary.textContent = `${ba.bridgeCount} bridge${ba.bridgeCount === 1 ? "" : "s"} · L${ba.fineLevel} clusters spanning ≥2 L${ba.coarseLevel} parents.`;
    wrap.appendChild(summary);

    // ── Table ──
    const fine = levels[ba.fineLevel].clusterResult;
    const rows = ba.perCluster
      .filter(p => p.isBridgeAtCoarse)
      .map(p => {
        const fineCluster = fine && fine.clusters[p.fineId];
        const at = p.byLevel[ba.coarseLevel];
        return {
          fineId:   p.fineId,
          count:    p.memberCount,
          span:     at ? at.spanCount : 0,
          colour:   fineCluster ? fineCluster.colour : "#888",
          byLevel:  p.byLevel,
        };
      });

    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel-bridge-empty";
      empty.textContent = `No fine clusters bridge at the (L${ba.fineLevel}, L${ba.coarseLevel}) pair. Try a different pair, or coarsen the upstream level.`;
      wrap.appendChild(empty);
      return;
    }

    // Sortable header.
    const table = document.createElement("table");
    table.className = "panel-bridge-table";
    wrap.appendChild(table);

    const baseCols = [
      { key: "colour", label: "",                          align: "left",  sortable: false, value: () => 0 },
      { key: "fineId", label: `L${ba.fineLevel} id`,       align: "right", sortable: true,  value: r => r.fineId },
      { key: "count",  label: "count",                     align: "right", sortable: true,  value: r => r.count },
      { key: "span",   label: `span @L${ba.coarseLevel}`,  align: "right", sortable: true,  value: r => r.span },
    ];
    // Per-coarser-level share columns — one for each level coarser
    // than fine. Shows "1:60% 2:25% 3:15%" form so the user can read
    // which coarse cluster the fine cluster's members fell into.
    const shareCols = [];
    for (let j = 0; j < ba.fineLevel; j++) {
      shareCols.push({
        key:     `lvl${j}`,
        label:   `L${j} shares`,
        align:   "left",
        sortable: false,
        value:   () => 0,
        render:  r => {
          const at = r.byLevel.find(x => x.coarseLevel === j);
          if (!at) return "";
          return formatShares(at.shares);
        },
      });
    }
    const cols = [...baseCols, ...shareCols];

    let sortKey = "count";
    let sortDir = "desc";

    function rebuild() {
      table.innerHTML = "";
      const thead = document.createElement("thead");
      const trh = document.createElement("tr");
      for (const col of cols) {
        const th = document.createElement("th");
        th.textContent = col.label;
        th.style.textAlign = col.align;
        if (col.sortable) {
          th.classList.add("sortable");
          if (col.key === sortKey) th.classList.add("sorted-" + sortDir);
          th.addEventListener("click", () => {
            if (sortKey === col.key) {
              sortDir = sortDir === "asc" ? "desc" : "asc";
            } else {
              sortKey = col.key;
              sortDir = "desc";
            }
            rebuild();
          });
        }
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);

      const sorted = rows.slice().sort((a, b) => {
        const col = cols.find(c => c.key === sortKey);
        if (!col) return 0;
        const av = col.value(a), bv = col.value(b);
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (sortDir === "asc" ? 1 : -1);
      });

      const sel = s.selection || {};
      const isSelected = (r) => sel.type === "cluster" && sel.level === ba.fineLevel && sel.id === r.fineId;

      const tbody = document.createElement("tbody");
      for (const r of sorted) {
        const tr = document.createElement("tr");
        tr.className = "panel-bridge-row";
        if (isSelected(r)) tr.classList.add("selected");
        for (const col of cols) {
          const td = document.createElement("td");
          td.style.textAlign = col.align;
          if (col.key === "colour") {
            const swatch = document.createElement("span");
            swatch.className = "panel-bridge-swatch";
            swatch.style.background = r.colour;
            td.appendChild(swatch);
          } else if (col.render) {
            td.innerHTML = col.render(r);
          } else {
            td.textContent = String(col.value(r));
          }
          tr.appendChild(td);
        }
        tr.addEventListener("click", () => {
          // Toggle: if already selected, clear; otherwise select.
          if (isSelected(r)) {
            setSelection({ type: null, id: null });
          } else {
            setSelection({ type: "cluster", level: ba.fineLevel, id: r.fineId });
          }
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }

    rebuild();
  }

  render();
  const unsub = subscribe(() => render());
  return {
    update() { render(); },
    destroy() { unsub(); },
  };
}

function makeLabel(text) {
  const l = document.createElement("label");
  l.className = "panel-bridge-pairbar-label";
  l.textContent = text;
  return l;
}

function makePairSelect() {
  const s = document.createElement("select");
  s.className = "panel-bridge-pair-select";
  return s;
}

// Render a shares array (sorted desc by count) as "id:pct id:pct …".
function formatShares(shares) {
  if (!Array.isArray(shares) || shares.length === 0) return "";
  return shares
    .map(sh => `${sh.id}:${Math.round(sh.fraction * 100)}%`)
    .join("  ");
}
