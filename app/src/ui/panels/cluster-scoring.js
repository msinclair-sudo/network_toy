// Panel: tree scoring (MLC §5).
//
// A minimal in-toy scorer — one job: show a cluster's label + colour +
// size, take a 1–5 score. Layer-by-layer with parent-score threshold
// propagation:
//   - Top (coarsest) layer first: score the few coarse clusters.
//   - Descend a layer: the finer clusters are FILTERED by a threshold
//     slider on their dominant parent's score — raise it to see only
//     children of well-scored parents, lower it to widen. Each fine
//     cluster shows which parent(s) it came from + their scores.
//   - Bridges (a fine cluster spanning ≥2 coarse parents below τ) sit in a
//     separate section, shown if ANY parent clears the threshold.
//
// Scores persist on state.clusterScores keyed by the LEVEL UID (so each
// clustering branch keeps its own scores and they survive save/load).
// Labels come from the multi-method labelling module (§7); with no titles
// materialised they fall back to the representative paper / cluster id.

import { getState, subscribe, setSelection, setClusterScore } from "../state.js";
import { computeBridgeAnalysis }                              from "../bridge-analysis.js";
import { labelClusters }                                      from "../../labelling/cluster-labels.js";
import { getNodeText, hasSqliteText }                         from "../../datasource/sqlite.js";

export const ID          = "cluster-scoring";
export const LABEL       = "Tree scoring";
export const DESCRIPTION = "Score clusters 1–5, layer by layer, with parent-score threshold propagation and a separate bridges section.";
export const SINGLETON   = true;

export function mount(container, _state, _config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-score";
  container.appendChild(wrap);

  let activeLayer = 0;          // which level is being scored
  let parentThreshold = 0;      // 0..5 — hide children of low-scored parents
  let tau = 0.8;                // encapsulated vs bridge cutoff
  let labelCache = { rev: -1, byLevel: {} };

  function levelsAndCtx() {
    const s = getState();
    const levels = s.clusterLevels || [];
    const ctx = {
      embedding: s.embedding || (s._basePos ? { d: 3, data: s._basePos } : null),
      nodes:     (s.genResult && s.genResult.nodes) || [],
      getText:   hasSqliteText() ? getNodeText : undefined,  // live from biblion SQLite corpus
    };
    return { s, levels, ctx };
  }

  // Resolve labels for a level. Prefer the STORED labels from an upstream
  // labelling card (projected into state.clusterLabels, keyed by level uid)
  // — labelling is a static card, so we don't recompute live. Fall back to
  // an inline compute only when no labelling card has run, so a bare
  // clustering still shows representative-paper labels.
  function labelsFor(levels, levelIdx, ctx, rev) {
    const uid = levels[levelIdx].uid;
    const stored = getState().clusterLabels;
    if (stored && stored[uid]) return stored[uid];
    if (labelCache.rev !== rev) labelCache = { rev, byLevel: {} };
    if (!labelCache.byLevel[uid]) {
      try {
        labelCache.byLevel[uid] = labelClusters(levels[levelIdx].clusterResult, ctx);
      } catch (e) {
        labelCache.byLevel[uid] = { perCluster: [] };
      }
    }
    return labelCache.byLevel[uid];
  }

  function render() {
    wrap.innerHTML = "";
    const { s, levels, ctx } = levelsAndCtx();

    const header = document.createElement("div");
    header.className = "panel-score-header";
    const title = document.createElement("div");
    title.className = "panel-score-title";
    title.textContent = "Tree scoring";
    header.appendChild(title);

    if (levels.length === 0) {
      wrap.appendChild(header);
      wrap.appendChild(empty(
        "No clustering to score. Run a clustering (or an Optimise multi-layer " +
        "run) first, then select its card."));
      return;
    }
    if (activeLayer >= levels.length) activeLayer = levels.length - 1;

    // Layer selector.
    const layerBar = document.createElement("div");
    layerBar.className = "panel-score-layerbar";
    layerBar.appendChild(label("Layer:"));
    const layerSel = document.createElement("select");
    layerSel.className = "panel-score-select";
    for (let i = 0; i < levels.length; i++) {
      const o = document.createElement("option");
      o.value = String(i);
      const k = levels[i].clusterResult.clusters.length;
      o.textContent = `L${i} · ${k} clusters` + (i === 0 ? " (coarsest)" : i === levels.length - 1 ? " (finest)" : "");
      if (i === activeLayer) o.selected = true;
      layerSel.appendChild(o);
    }
    layerSel.addEventListener("change", () => { activeLayer = parseInt(layerSel.value, 10); render(); });
    layerBar.appendChild(layerSel);
    header.appendChild(layerBar);

    // Parent-threshold + τ (only meaningful below the top layer).
    if (activeLayer > 0) {
      const ctrlBar = document.createElement("div");
      ctrlBar.className = "panel-score-ctrlbar";
      ctrlBar.appendChild(label("Parent ≥"));
      const thr = rangeInput(0, 5, 1, parentThreshold);
      const thrVal = document.createElement("span");
      thrVal.className = "panel-score-ctrl-val";
      thrVal.textContent = parentThreshold === 0 ? "any" : String(parentThreshold);
      thr.addEventListener("input", () => {
        parentThreshold = parseInt(thr.value, 10);
        thrVal.textContent = parentThreshold === 0 ? "any" : String(parentThreshold);
        render();
      });
      ctrlBar.appendChild(thr);
      ctrlBar.appendChild(thrVal);

      ctrlBar.appendChild(label("τ"));
      const tauI = rangeInput(0.5, 1, 0.05, tau);
      const tauV = document.createElement("span");
      tauV.className = "panel-score-ctrl-val";
      tauV.textContent = tau.toFixed(2);
      tauI.addEventListener("input", () => { tau = parseFloat(tauI.value); tauV.textContent = tau.toFixed(2); render(); });
      ctrlBar.appendChild(tauI);
      ctrlBar.appendChild(tauV);
      header.appendChild(ctrlBar);
    }
    wrap.appendChild(header);

    const levelUid = levels[activeLayer].uid;
    const cr = levels[activeLayer].clusterResult;
    const labels = labelsFor(levels, activeLayer, ctx, s.engineRevision || 0);
    const scores = (s.clusterScores && s.clusterScores[levelUid]) || {};

    // Scored-progress summary.
    const nScored = Object.keys(scores).length;
    const summary = document.createElement("div");
    summary.className = "panel-score-summary";
    summary.textContent = `${nScored} / ${cr.clusters.length} scored at L${activeLayer}`;
    wrap.appendChild(summary);

    if (activeLayer === 0) {
      // Top layer — score every coarse cluster, no parent filter.
      const section = document.createElement("div");
      for (const cl of cr.clusters) {
        section.appendChild(clusterRow(cl, labels, scores, levelUid, null, s));
      }
      wrap.appendChild(section);
      return;
    }

    // Below top — bucket by parent score threshold + τ (encapsulated/bridge).
    const ba = computeBridgeAnalysis(levels, { fineLevel: activeLayer, coarseLevel: activeLayer - 1 });
    const parentUid = levels[activeLayer - 1].uid;
    const parentScores = (s.clusterScores && s.clusterScores[parentUid]) || {};
    const byFine = new Map(ba.perCluster.map(p => [p.fineId, p]));

    const encap = [], bridges = [];
    for (const cl of cr.clusters) {
      const p = byFine.get(cl.id);
      const at = p && p.byLevel[activeLayer - 1];
      const shares = at ? at.shares : [];
      const dom = at ? at.dominantFraction : 1;
      const span = at ? at.spanCount : 1;
      const isBridge = span >= 2 && dom < tau;
      const parentScoreOf = (pid) => parentScores[pid];
      const dominantParentScore = shares.length ? parentScoreOf(shares[0].id) : undefined;
      const anyParentClears = shares.some(sh => (parentScoreOf(sh.id) || 0) >= parentThreshold);
      const passes = isBridge ? anyParentClears : ((dominantParentScore || 0) >= parentThreshold);
      if (!passes) continue;
      const parentInfo = shares.map(sh => ({ id: sh.id, fraction: sh.fraction, score: parentScoreOf(sh.id) }));
      (isBridge ? bridges : encap).push({ cl, parentInfo, dom, span, isBridge });
    }

    appendScoreSection(wrap, "Encapsulated", encap, labels, scores, levelUid, s);
    appendScoreSection(wrap, "Bridges", bridges, labels, scores, levelUid, s);
  }

  function appendScoreSection(parent, heading, items, labels, scores, levelUid, s) {
    const h = document.createElement("div");
    h.className = "panel-score-section-head";
    h.textContent = `${heading} — ${items.length}`;
    parent.appendChild(h);
    if (items.length === 0) {
      parent.appendChild(empty("(none clear the parent threshold)"));
      return;
    }
    for (const it of items) {
      parent.appendChild(clusterRow(it.cl, labels, scores, levelUid, it.parentInfo, s,
        { dom: it.dom, span: it.span, isBridge: it.isBridge }));
    }
  }

  // One cluster row: swatch + label + size + (parent provenance) + a
  // straddle metric badge (bridge analysis informing the manual score) + 1–5.
  function clusterRow(cl, labels, scores, levelUid, parentInfo, s, metric = null) {
    const row = document.createElement("div");
    row.className = "panel-score-row";
    const sel = s.selection || {};
    if (sel.type === "cluster" && sel.level === activeLayer && sel.id === cl.id) {
      row.classList.add("selected");
    }

    const swatch = document.createElement("span");
    swatch.className = "panel-score-swatch";
    swatch.style.background = cl.colour || "#888";
    row.appendChild(swatch);

    const main = document.createElement("div");
    main.className = "panel-score-main";
    const lab = document.createElement("div");
    lab.className = "panel-score-label";
    const info = labels.perCluster && labels.perCluster[cl.id];
    lab.textContent = (info && info.combined && info.combined !== "(unlabelled)")
      ? info.combined : `Cluster ${cl.id}`;
    main.appendChild(lab);

    const meta = document.createElement("div");
    meta.className = "panel-score-meta";
    let metaText = `#${cl.id} · ${cl.count} nodes`;
    if (parentInfo && parentInfo.length) {
      const parts = parentInfo.map(pi =>
        `${pi.id}:${Math.round(pi.fraction * 100)}%${pi.score ? `(${pi.score}★)` : ""}`);
      metaText += ` · parents ${parts.join(" ")}`;
    }
    meta.textContent = metaText;
    main.appendChild(meta);

    // Straddle metric badge — surfaces the bridge-analysis number next to
    // the stars so the manual 1–5 score is made with the geometry in view.
    // dominantFraction = how much of the cluster sits in its single biggest
    // parent; straddle = 1 − that. Bridges (span ≥ 2 under τ) are flagged.
    if (metric && Number.isFinite(metric.dom)) {
      const badge = document.createElement("span");
      badge.className = "panel-score-bridge-badge"
        + (metric.isBridge ? " is-bridge" : "");
      const straddlePct = Math.round((1 - metric.dom) * 100);
      badge.textContent = metric.isBridge
        ? `bridge · straddles ${straddlePct}% across ${metric.span}`
        : `clean · ${Math.round(metric.dom * 100)}% in parent`;
      badge.title = "From bridge analysis: dominant-parent share vs straddle. "
        + "Lower dominance / higher span = more of a bridge.";
      main.appendChild(badge);
    }
    row.appendChild(main);

    // 1–5 control.
    const ctrl = document.createElement("div");
    ctrl.className = "panel-score-stars";
    const current = scores[cl.id];
    for (let v = 1; v <= 5; v++) {
      const b = document.createElement("button");
      b.className = "panel-score-star" + (current === v ? " active" : "");
      b.textContent = String(v);
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        setClusterScore(levelUid, cl.id, current === v ? null : v);
      });
      ctrl.appendChild(b);
    }
    row.appendChild(ctrl);

    // Clicking the row (not a star) selects the cluster in the viewers.
    row.addEventListener("click", () => {
      setSelection({ type: "cluster", level: activeLayer, id: cl.id });
    });
    return row;
  }

  render();
  const unsub = subscribe(() => render());
  return {
    update() { render(); },
    destroy() { unsub(); },
  };
}

function empty(text) {
  const e = document.createElement("div");
  e.className = "panel-score-empty";
  e.textContent = text;
  return e;
}
function label(text) {
  const l = document.createElement("label");
  l.className = "panel-score-ctrl-label";
  l.textContent = text;
  return l;
}
function rangeInput(min, max, step, value) {
  const r = document.createElement("input");
  r.type = "range";
  r.min = String(min); r.max = String(max); r.step = String(step);
  r.value = String(value);
  r.className = "panel-score-range";
  return r;
}
