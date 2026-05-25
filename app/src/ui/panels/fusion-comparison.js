// Panel: fusion comparison (§6.19 step 8).
//
// Quantifies how much Layer 1.5's citation-aware fusion stage
// reorganises the topic map vs. the pre-fusion (noise-only)
// embedding. Reads `state.clusterLevels` (post-fusion) +
// `state.clusterLevelsPreFusion` (pre-fusion); when the latter is
// null (toy mode, or fusion=identity) the panel shows an empty hint.
//
// Surface:
//   - Level picker (when multiple levels exist).
//   - Aggregate metric strip: ARI · NMI · macro Jaccard ·
//     n clusters pre/post · noise pre/post · n reorganised.
//   - Sortable per-pre-cluster table: pre-id → best-matched post-id
//     + Jaccard + member count + retained / lost + biggest-share
//     post-cluster (where most of pre's members ended up).
//   - Top-N movers list: papers with lowest retention (their
//     pre-cluster peers were most thoroughly dispersed by fusion).
//
// Live-only for now. The plan §6.19 step 8 notes a future
// `type: "fusionComparison"` ValidationRun once cross-view metrics
// stabilise; this panel currently re-derives on every state change.

import { getState, subscribe, setSelection } from "../state.js";
import { compareFusionPartitions }            from "../../eval/fusion-compare.js";

export const ID          = "fusion-comparison";
export const LABEL       = "Fusion comparison";
export const DESCRIPTION = "How much does Layer 1.5 fusion reorganise the topic map? ARI / NMI / macro Jaccard between pre- and post-fusion partitions, per-cluster best-match table, biggest-mover papers.";
export const SINGLETON   = true;

export function mount(container, _state, _config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-fc";
  container.appendChild(wrap);

  // Memoise the heavy comparison across irrelevant state ticks. The
  // (preCr, postCr, level) triple identifies a comparison uniquely;
  // any selection / blend / viewer change shouldn't re-run it.
  let cachedKey  = null;
  let cachedFC   = null;
  let selectedLevel = 0;
  let sortKey    = "preId";
  let sortDir    = "asc";

  function render() {
    wrap.innerHTML = "";
    const s = getState();
    const levels    = s.clusterLevels || [];
    const levelsPre = s.clusterLevelsPreFusion;

    // ── Header ──
    const header = document.createElement("div");
    header.className = "panel-fc-header";
    const title = document.createElement("div");
    title.className = "panel-fc-title";
    title.textContent = "Fusion comparison";
    header.appendChild(title);
    wrap.appendChild(header);

    // Empty state. Either pre-fusion isn't populated, or shapes
    // don't line up. Most common in toy mode + fusion=identity.
    if (!levelsPre || !Array.isArray(levelsPre) || levelsPre.length === 0 || levels.length === 0) {
      const empty = document.createElement("div");
      empty.className = "panel-fc-empty";
      empty.textContent = "Fusion comparison needs a non-identity fusion stage. Open the Dim-reduction modal → Fusion → graph-diffusion → Apply (real-data mode only — toy citations are generated downstream and can't feed fusion on the first pass).";
      wrap.appendChild(empty);
      return;
    }

    if (selectedLevel >= Math.min(levels.length, levelsPre.length)) {
      selectedLevel = 0;
    }

    // Level picker (only when multiple levels exist).
    if (Math.min(levels.length, levelsPre.length) > 1) {
      const picker = document.createElement("div");
      picker.className = "panel-fc-levelpicker";
      const lbl = document.createElement("label");
      lbl.textContent = "Level:";
      picker.appendChild(lbl);
      const sel = document.createElement("select");
      const maxLvl = Math.min(levels.length, levelsPre.length);
      for (let i = 0; i < maxLvl; i++) {
        const o = document.createElement("option");
        o.value = String(i); o.textContent = `L${i}`;
        if (i === selectedLevel) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", () => {
        selectedLevel = parseInt(sel.value, 10);
        render();
      });
      picker.appendChild(sel);
      header.appendChild(picker);
    }

    const preLvl  = levelsPre[selectedLevel];
    const postLvl = levels[selectedLevel];
    if (!preLvl || !postLvl) {
      const empty = document.createElement("div");
      empty.className = "panel-fc-empty";
      empty.textContent = `(no cluster data at L${selectedLevel})`;
      wrap.appendChild(empty);
      return;
    }
    const preCr  = preLvl.clusterResult;
    const postCr = postLvl.clusterResult;

    // Compute (with cache).
    const key = `${selectedLevel}:${preLvl.uid || preLvl}:${postLvl.uid || postLvl}`;
    if (cachedKey !== key) {
      try {
        cachedFC = compareFusionPartitions(preCr, postCr, { topMoversN: 25 });
      } catch (e) {
        console.error("[fusion-comparison] compare failed:", e);
        const err = document.createElement("div");
        err.className = "panel-fc-empty";
        err.textContent = `Comparison error: ${e.message || e}`;
        wrap.appendChild(err);
        return;
      }
      cachedKey = key;
    }
    const fc = cachedFC;

    // ── Aggregate strip ──
    const aggRow = document.createElement("div");
    aggRow.className = "panel-fc-agg";
    aggRow.innerHTML = `
      <span><b>ARI</b> ${fmtScalar(fc.aggregate.ari)}</span>
      <span><b>NMI</b> ${fmtScalar(fc.aggregate.nmi_arith)}</span>
      <span><b>macro J</b> ${fmtScalar(fc.aggregate.macroJaccard)}</span>
      <span><b>clusters</b> ${fc.aggregate.nClustersPre} → ${fc.aggregate.nClustersPost}</span>
      <span><b>noise</b> ${fmtScalar(fc.aggregate.noiseFractionPre)} → ${fmtScalar(fc.aggregate.noiseFractionPost)}</span>
      <span><b>reorganised</b> ${fc.aggregate.nReorganised} <span class="panel-fc-hint">(retention &lt; 0.5)</span></span>
    `;
    wrap.appendChild(aggRow);

    const interpretation = document.createElement("div");
    interpretation.className = "panel-fc-interpretation";
    interpretation.textContent = interpretMetrics(fc.aggregate);
    wrap.appendChild(interpretation);

    // ── Per-cluster table ──
    const tableTitle = document.createElement("div");
    tableTitle.className = "panel-fc-section";
    tableTitle.textContent = "Per pre-fusion cluster · best match → post-fusion";
    wrap.appendChild(tableTitle);

    const table = document.createElement("table");
    table.className = "panel-fc-table";
    wrap.appendChild(table);

    const cols = [
      { key: "preId",       label: "pre",       align: "right", value: r => r.preId },
      { key: "postId",      label: "→ post",    align: "right", value: r => r.postId },
      { key: "jaccard",     label: "Jaccard",   align: "right", value: r => r.jaccard,
        fmt: v => fmtScalar(v) },
      { key: "memberCount", label: "size",      align: "right", value: r => r.memberCount },
      { key: "retainedCount", label: "kept",    align: "right", value: r => r.retainedCount },
      { key: "lostCount",   label: "lost",      align: "right", value: r => r.lostCount },
      { key: "biggestPostShare", label: "biggest → post", align: "right",
        value: r => r.biggestPostShare.postId,
        fmt: (_v, r) => r.biggestPostShare.count > 0
          ? `${r.biggestPostShare.postId} (${r.biggestPostShare.count})`
          : "—" },
    ];

    function rebuildTable() {
      table.innerHTML = "";
      const thead = document.createElement("thead");
      const trh = document.createElement("tr");
      for (const col of cols) {
        const th = document.createElement("th");
        th.textContent = col.label;
        th.style.textAlign = col.align;
        th.classList.add("sortable");
        if (col.key === sortKey) th.classList.add("sorted-" + sortDir);
        th.addEventListener("click", () => {
          if (sortKey === col.key) sortDir = sortDir === "asc" ? "desc" : "asc";
          else { sortKey = col.key; sortDir = "asc"; }
          rebuildTable();
        });
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);

      const sorted = fc.perCluster.slice().sort((a, b) => {
        const col = cols.find(c => c.key === sortKey);
        const av = col.value(a), bv = col.value(b);
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (sortDir === "asc" ? 1 : -1);
      });

      const sel = getState().selection || {};
      const isSel = (r) =>
        sel.type === "cluster" && sel.level === selectedLevel && sel.id === r.preId;

      const tbody = document.createElement("tbody");
      for (const r of sorted) {
        const tr = document.createElement("tr");
        tr.className = "panel-fc-row";
        if (isSel(r)) tr.classList.add("selected");
        for (const col of cols) {
          const td = document.createElement("td");
          td.style.textAlign = col.align;
          const raw = col.value(r);
          td.textContent = col.fmt ? col.fmt(raw, r) : String(raw);
          tr.appendChild(td);
        }
        tr.addEventListener("click", () => {
          if (isSel(r)) setSelection({ type: null, id: null });
          else          setSelection({ type: "cluster", level: selectedLevel, id: r.preId });
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }
    rebuildTable();

    // ── Top movers list ──
    if (fc.topMovers.length > 0) {
      const moversTitle = document.createElement("div");
      moversTitle.className = "panel-fc-section";
      moversTitle.textContent = `Top movers · lowest retention (n=${fc.topMovers.length})`;
      wrap.appendChild(moversTitle);

      const moversTable = document.createElement("table");
      moversTable.className = "panel-fc-movers";
      const thead = document.createElement("thead");
      thead.innerHTML = `<tr>
        <th class="r">idx</th>
        <th class="r">pre L${selectedLevel}</th>
        <th class="r">→ post L${selectedLevel}</th>
        <th class="r">retention</th>
      </tr>`;
      moversTable.appendChild(thead);

      const tbody = document.createElement("tbody");
      for (const m of fc.topMovers) {
        const tr = document.createElement("tr");
        tr.className = "panel-fc-mover-row";
        tr.innerHTML = `
          <td class="r">${m.nodeIdx}</td>
          <td class="r">${m.preId}</td>
          <td class="r">${m.postId}</td>
          <td class="r">${fmtScalar(m.retention)}</td>
        `;
        tr.addEventListener("click", () => {
          const curSel = getState().selection || {};
          if (curSel.type === "node" && curSel.id === m.nodeIdx) {
            setSelection({ type: null, id: null });
          } else {
            setSelection({ type: "node", id: m.nodeIdx });
          }
        });
        tbody.appendChild(tr);
      }
      moversTable.appendChild(tbody);
      wrap.appendChild(moversTable);
    }
  }

  render();
  const unsub = subscribe(() => render());

  return {
    update() { render(); },
    destroy() { unsub(); },
  };
}

// ── helpers ──

function fmtScalar(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(2);
  return v.toFixed(3);
}

function interpretMetrics(agg) {
  if (!Number.isFinite(agg.ari)) return "(insufficient data for interpretation)";
  if (agg.ari > 0.85) {
    return "Pre- and post-fusion partitions agree strongly. Fusion is doing little — either citations carry the same signal as the embedding, or α is too low.";
  }
  if (agg.ari > 0.5) {
    return "Moderate disagreement. Fusion is moving the clustering somewhere genuinely different but the high-level structure is preserved.";
  }
  return "Substantial reorganisation. Citations are pulling clusters into a meaningfully different topology than the embedding alone produces.";
}
