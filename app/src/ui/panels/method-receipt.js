// Panel: method receipt — auto-generated defensibility paragraph.
//
// The §6.18 endpoint was being able to point at the Optimise output
// and say "this is the best config of those I considered, under
// metric M, with stability quantified by bootstrap protocol P, on
// data D; here are the assumptions M and P make and how they
// might fail." This panel literally renders that paragraph,
// assembled from the live state — clustering algo + params, the
// active scorer + bootstrap settings (from the latest sweep when
// present, otherwise defaults), the Bayes-optimal ARI ceiling for
// the data (when computed).
//
// Read-only. Re-renders on every state change so the receipt stays
// in sync with whatever the user has actually applied. A copy-to-
// clipboard button makes it easy to drop straight into a paper or
// supervisor email.

import { getState, subscribe }    from "../state.js";
import { getAlgorithm as getClusteringAlgo } from "../../clustering-registry.js";
import {
  SCORE_VERSION, DEFAULT_MIN_MEMBERS, HENNIG_STABLE, HENNIG_DOUBTFUL,
}                                  from "../../eval/bootstrap.js";

export const ID          = "method-receipt";
export const LABEL       = "Method receipt";
export const DESCRIPTION = "Auto-generated defensibility paragraph describing the active clustering's methodology (algorithm, params, bootstrap protocol, data fixture, scoring). Updates as state changes.";
export const SINGLETON   = true;

export function mount(container, _state, _config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-method-receipt";
  container.appendChild(wrap);

  function render() {
    wrap.innerHTML = "";
    const s = getState();

    const head = document.createElement("div");
    head.className = "panel-mr-header";
    const title = document.createElement("div");
    title.className = "panel-mr-title";
    title.textContent = "Method receipt";
    head.appendChild(title);
    const sub = document.createElement("div");
    sub.className = "panel-mr-sub";
    sub.textContent = "Reads from the currently-applied state. Copy-paste-ready.";
    head.appendChild(sub);
    wrap.appendChild(head);

    const text = buildReceipt(s);
    const block = document.createElement("pre");
    block.className = "panel-mr-text";
    block.textContent = text;
    wrap.appendChild(block);

    const actions = document.createElement("div");
    actions.className = "panel-mr-actions";
    const copyBtn = document.createElement("button");
    copyBtn.type = "button";
    copyBtn.className = "panel-mr-copy";
    copyBtn.textContent = "Copy to clipboard";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(text)
        .then(() => {
          copyBtn.textContent = "Copied ✓";
          setTimeout(() => { copyBtn.textContent = "Copy to clipboard"; }, 1500);
        })
        .catch(err => {
          console.error("[method-receipt] clipboard write failed:", err);
          copyBtn.textContent = "Copy failed";
          setTimeout(() => { copyBtn.textContent = "Copy to clipboard"; }, 1500);
        });
    });
    actions.appendChild(copyBtn);
    wrap.appendChild(actions);
  }

  render();
  const unsub = subscribe(() => render());
  return {
    update() { render(); },
    destroy() { unsub(); },
  };
}

// Build the defensibility paragraph from current state. Returns
// plain text (newlines preserved). Designed to be honest about
// unknowns — when a field isn't available (no sweep run yet, toy
// data without ARI ceiling, etc.), the paragraph says so explicitly
// rather than filling in a misleading default.
function buildReceipt(state) {
  const lines = [];

  // ── Clustering: active algorithm + params + level structure. ──
  const cfg = state.layerParams && state.layerParams.clustering;
  const lvls = state.clusterLevels || [];
  if (cfg && lvls.length > 0) {
    const algoId = cfg.method;
    let algoLabel = algoId;
    try {
      const a = getClusteringAlgo(algoId);
      algoLabel = a && a.label ? a.label : algoId;
    } catch (_) { /* registry might not know it; use id */ }
    const finest = lvls[lvls.length - 1].clusterResult;
    const nClusters = finest ? finest.clusters.length : "?";
    lines.push(`Clustering: ${algoLabel} (${algoId}), ${lvls.length} level${lvls.length > 1 ? "s" : ""}, ${nClusters} clusters at the finest level.`);

    cfg.levels.forEach((lvl, i) => {
      const params = lvl.params ? Object.entries(lvl.params)
        .map(([k, v]) => `${k}=${formatParamVal(v)}`)
        .join(", ") : "(defaults)";
      const scopeTag = i === 0 ? "global" : (lvl.scope || "within-parent");
      lines.push(`  L${i} [${scopeTag}]: ${params}`);
    });
  } else {
    lines.push("Clustering: none applied yet.");
  }
  lines.push("");

  // ── Data fixture. ──
  const ds = state.dataSource;
  if (ds) {
    const mode = ds.mode || "?";
    const conf = (ds.configs && ds.configs[mode]) || {};
    if (mode === "toy") {
      const gen = state.genResult;
      const n = gen ? gen.nodes.length : "?";
      const origins = conf.origins != null ? conf.origins : "?";
      const seed    = conf.seed    != null ? conf.seed    : "?";
      const spread  = conf.spread  != null ? conf.spread  : "?";
      lines.push(`Data: toy Gaussian-mixture, n=${n}, ${origins} origins, spread=${spread}, seed=${seed}.`);
    } else if (mode === "real") {
      const subset = conf.subset || "(unknown subset)";
      const gen = state.genResult;
      const n = gen ? gen.nodes.length : "?";
      lines.push(`Data: real (${subset}), n=${n}.`);
    } else {
      lines.push(`Data: ${mode}, n=${state.genResult ? state.genResult.nodes.length : "?"}.`);
    }
  }
  lines.push("");

  // ── Dim-reduction pipeline. ──
  const dimred = state.layerParams && state.layerParams.dimred;
  if (dimred) {
    const slots = ["noise", "fusion", "compression", "viz", "viz2d"];
    const activeSlots = slots.filter(s => dimred[s] && dimred[s].method && dimred[s].method !== "identity");
    if (activeSlots.length > 0) {
      lines.push("Dim-reduction:");
      for (const slot of activeSlots) {
        const cfg = dimred[slot];
        const params = cfg.params ? Object.entries(cfg.params)
          .filter(([k]) => k !== "adjacency")    // huge; skip for readability
          .map(([k, v]) => `${k}=${formatParamVal(v)}`)
          .join(", ") : "(defaults)";
        lines.push(`  ${slot}: ${cfg.method}${params ? " — " + params : ""}`);
      }
    } else {
      lines.push("Dim-reduction: all slots at identity (no transformation).");
    }
  }
  lines.push("");

  // ── Bootstrap protocol (from latest Optimise sweep settings if
  // present; else defaults). ──
  const opt = state.evalResults && state.evalResults.optimise;
  const sweepSettings = opt && opt.settings ? opt.settings : null;
  const B           = sweepSettings && sweepSettings.B          != null ? sweepSettings.B          : 10;
  const subFrac     = 0.5;   // hard default; not surfaced in sweep settings yet
  const noiseHandl  = sweepSettings && sweepSettings.noiseHandling || "exclude";
  const minMembers  = DEFAULT_MIN_MEMBERS;
  lines.push(`Bootstrap protocol (SCORE_VERSION ${SCORE_VERSION}):`);
  lines.push(`  Subsampling without replacement, fraction=${subFrac}, B=${B} iterations.`);
  lines.push(`  Bipartite-matched Jaccard scoring (no greedy double-counting).`);
  lines.push(`  Reference clusters with < ${minMembers} in-subsample members excluded per iter.`);
  lines.push(`  Noise handling: "${noiseHandl}"${noiseHandlingExplanation(noiseHandl)}.`);
  lines.push(`  Hennig thresholds: stable ≥ ${HENNIG_STABLE}, doubtful ${HENNIG_DOUBTFUL}–${HENNIG_STABLE}, unstable < ${HENNIG_DOUBTFUL} (used for colour breakdown only — primary metrics are macro / unweighted mean Jaccard).`);
  lines.push("");

  // ── Latest sweep (if any). ──
  if (opt && opt.ranked && opt.ranked.length > 0) {
    const scorerLabel = opt.scorerLabel || opt.scorerId || "(unknown scorer)";
    const top = opt.ranked[0];
    const finiteVals = opt.ranked.map(r => r.primary).filter(v => Number.isFinite(v));
    let distSummary = "";
    if (finiteVals.length >= 2) {
      const sorted = finiteVals.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const mean = finiteVals.reduce((s, v) => s + v, 0) / finiteVals.length;
      const sd = Math.sqrt(finiteVals.reduce((s, v) => s + (v - mean) * (v - mean), 0) / finiteVals.length);
      distSummary = ` (others spanned [${sorted[0].toFixed(3)}, ${sorted[sorted.length - 1].toFixed(3)}], median ${median.toFixed(3)}, sd ${sd.toFixed(3)})`;
    }
    lines.push(`Latest sweep: ranked best of ${opt.totalConfigs} considered by "${scorerLabel}".`);
    lines.push(`  Top row: ${top.algoLabel || top.algoId}, primary=${formatScalar(top.primary)}, ${top.numClusters} clusters${distSummary}.`);
    lines.push("");
  } else {
    lines.push("Latest sweep: none in this session.");
    lines.push("");
  }

  // ── Bayes-optimal ARI ceiling (toy only). ──
  const gen = state.genResult;
  if (gen && Number.isFinite(gen.bayesOptimalAri)) {
    lines.push(`Bayes-optimal ARI ceiling for this mixture: ${gen.bayesOptimalAri.toFixed(3)}.`);
    lines.push(`  (Achieved ARI should be read as a fraction of optimal, not as an absolute.)`);
  }

  // ── Closing pointer. ──
  lines.push("");
  lines.push("References: doc/eval.md (full Optimise spec), doc/plan.md §6.18 (hardening pass audit).");

  return lines.join("\n");
}

function noiseHandlingExplanation(mode) {
  if (mode === "exclude")   return " (drop -1 noise points from both reference and bootstrap before matching)";
  if (mode === "asCluster") return " (remap -1 to a synthetic NOISE_ID; noise-vs-noise contributes to matching)";
  if (mode === "penalise")  return " (drop -1 from matching; multiply aggregates by 1 - noise fraction)";
  return "";
}

function formatScalar(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(2);
  return v.toFixed(3);
}

function formatParamVal(v) {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}
