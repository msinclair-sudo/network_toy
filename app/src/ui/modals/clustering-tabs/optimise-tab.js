// Optimise tab — sweeps clustering algorithms × params and ranks
// configs by a chosen scorer.
//
// Auto-picks the scorer based on data-source mode:
//   * toy  → ariScorer(originId)  (ground-truth available)
//   * real → stabilityScorer({B}) (Hennig fraction-stable)
// User can override via the "Ranked by" dropdown.
//
// Per-row Apply rewrites layerParams.clustering with the chosen
// (algoId, params) — single level, scope=global — and reclusters.
// After Apply, the parent modal switches to the Validate tab so the
// user can confirm the new config is stable.

import { getState, update, subscribe, setOptimiseResult, saveValidationRun } from "../../state.js";
import * as engine from "../../engine.js";
import { listAlgorithms } from "../../../clustering-registry.js";
import { sweepAcrossAlgorithms, runTargetRangeSweep } from "../../../eval/sweep.js";
import {
  ariScorer, stabilityScorer,
  numClustersScorer, clusterRichnessScorer,
} from "../../../eval/scorers.js";
import { SCORE_VERSION } from "../../../eval/bootstrap.js";
import { renderResults, formatScalar } from "./optimise-results-renderer.js";

export function buildOptimiseTab(host, opts = {}) {
  const onApplyRow = opts.onApplyRow || (() => {});
  // Provided by clustering-modal so the per-row Apply dropdown can list
  // existing levels + "+ New". Returns [{uid, index, scope, method}].
  // Optional — if absent, the Apply column reverts to a single
  // "Apply to L0" button.
  const getLevels   = opts.getLevels  || null;

  const allAlgos = listAlgorithms();
  // Per-algorithm enable flags.
  const enabled = new Map(allAlgos.map(a => [a.id, true]));

  // §6.18.4 — real AbortController per run so the cancel button (and
  // tab hide) actively terminates in-flight workers via
  // worker-runner.js's signal.addEventListener("abort", …) hook. We
  // pass `abortController.signal` everywhere the old polling-object
  // signal went; downstream checks for `.aborted` keep working (it's
  // a native AbortSignal property). Controller is freshly constructed
  // at run start because AbortController is one-shot — once aborted,
  // stays aborted.
  let abortController = null;
  const cancelCurrentRun = () => {
    if (abortController) abortController.abort();
  };

  // ── notice ──────────────────────────────────────────────────────
  const notice = document.createElement("div");
  notice.className = "cm-tab-notice";
  notice.textContent = "Sweeps algorithm × parameter combinations and ranks by how stable (or how accurate, in toy mode) the resulting clusters are.";
  host.appendChild(notice);

  // ── settings ────────────────────────────────────────────────────
  const settings = document.createElement("div");
  settings.className = "cm-tab-section";

  const settingsTitle = document.createElement("h4");
  settingsTitle.className = "cm-tab-section-title";
  settingsTitle.textContent = "Settings";
  settings.appendChild(settingsTitle);

  // Algorithms checkboxes.
  const algosRow = document.createElement("div");
  algosRow.className = "cm-tab-checkbox-row";
  const algosLabel = document.createElement("label");
  algosLabel.textContent = "Algorithms";
  algosRow.appendChild(algosLabel);
  const algosBody = document.createElement("div");
  algosBody.className = "cm-tab-checkbox-body";
  for (const a of allAlgos) {
    const lab = document.createElement("label");
    lab.className = "cm-tab-checkbox";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;
    cb.addEventListener("change", () => enabled.set(a.id, cb.checked));
    lab.appendChild(cb);
    const span = document.createElement("span");
    span.textContent = a.label || a.id;
    lab.appendChild(span);
    algosBody.appendChild(lab);
  }
  algosRow.appendChild(algosBody);
  settings.appendChild(algosRow);

  // B (bootstraps) — only meaningful for bootstrap-based scorers
  // (stability + richness). Ignored by ARI and numClusters.
  let B = 10;
  let scorerId = "auto";
  // §6.18.9 B8 — how the bootstrap treats -1 (noise) labels.
  //   "exclude"   — drop -1 from ref + cand before matching (default;
  //                 reproducibility scored only on the non-noise portion)
  //   "asCluster" — remap -1 to a synthetic NOISE_ID and match like a
  //                 real cluster (noise-vs-noise contributes)
  //   "penalise"  — same matching as exclude, but aggregate Jaccards
  //                 scaled by (1 − noiseFraction) so noisier
  //                 clusterings lose stability proportionally
  let noiseHandling = "exclude";
  // Sweep mode: "resolution" (default; sweep only resolution-tagged
  // fields), "full" (cartesian product of every modalSchema axis), or
  // "target" (LHS-driven hunt for configs producing a specific
  // cluster-count range — see eval/sweep.js runTargetRangeSweep).
  let sweepMode = "resolution";
  // Target-range params (only used when sweepMode === "target").
  let targetMin    = 5;
  let targetMax    = 20;
  let phase1Count  = 30;
  let refineStep   = 3;
  let targetBoot   = false;
  // Which dim-reduction the sweep optimises against. "post" = the
  // citation-aware (post-fusion) UMAP; "pre" = the semantic-only
  // (pre-fusion) UMAP; "both" = run the sweep twice and tag each row
  // by source so the user can see which params win on each surface.
  // Only meaningful when fusion is active; auto-collapses to "post"
  // when state.dimredResultPreFusion is null.
  let sweepAgainst = "post";

  // Sweep mode toggle — three radios.
  const depthRow = document.createElement("div");
  depthRow.className = "cm-tab-checkbox-row";
  const depthLabel = document.createElement("label");
  depthLabel.textContent = "Sweep mode";
  depthRow.appendChild(depthLabel);
  const depthBody = document.createElement("div");
  depthBody.className = "cm-tab-checkbox-body";
  for (const opt of [
    { value: "resolution", label: "Resolution only", checked: true },
    { value: "full",       label: "Full grid",       checked: false },
    { value: "target",     label: "Target range",    checked: false },
  ]) {
    const lab = document.createElement("label");
    lab.className = "cm-tab-checkbox";
    const r = document.createElement("input");
    r.type = "radio";
    r.name = "sweep-depth";
    r.value = opt.value;
    r.checked = opt.checked;
    r.addEventListener("change", () => {
      if (r.checked) {
        sweepMode = opt.value;
        // Show / hide the target-range settings panel.
        if (targetPanel) targetPanel.style.display = sweepMode === "target" ? "" : "none";
        // Sweep-against row only meaningful when pre-fusion data exists
        // (fusion ran). Auto-collapse to "post" if pre-fusion isn't
        // available; the visible row guides the user when it is.
        if (sweepMode === "target") refreshSweepAgainstVisibility();
        // Bootstraps slider only meaningful for full/resolution modes;
        // target mode has its own bootstrap toggle.
        if (bootstrapsRow) bootstrapsRow.style.display = sweepMode === "target" ? "none" : "";
      }
    });
    lab.appendChild(r);
    const span = document.createElement("span");
    span.textContent = opt.label;
    lab.appendChild(span);
    depthBody.appendChild(lab);
  }
  depthRow.appendChild(depthBody);
  const depthHint = document.createElement("div");
  depthHint.className = "cm-tab-slider-hint cm-tab-checkbox-hint";
  depthHint.textContent = "Resolution only: tries different settings for the parameters that control cluster count (e.g. min cluster size, k). Faster. Full grid: tries every combination of every parameter — much slower. Target range: looks for settings producing a specific cluster-count band; Latin-hypercube probe + neighbourhood refine, much cheaper when you know what cluster count you want.";
  depthRow.appendChild(depthHint);
  settings.appendChild(depthRow);

  // ── Target-range settings panel (hidden unless sweepMode === "target"). ──
  const targetPanel = document.createElement("div");
  targetPanel.className = "cm-tab-section";
  targetPanel.style.display = "none";        // hidden by default
  targetPanel.style.marginTop = "4px";
  targetPanel.style.paddingLeft = "12px";
  targetPanel.style.borderLeft = "2px solid var(--bg-3)";

  // ── Sweep-against radio row (which dim-reduction to optimise against). ──
  // Hidden when fusion isn't active (no pre-fusion to compare against).
  // Builds the row eagerly but the wrapper auto-hides based on state.
  const againstRow = document.createElement("div");
  againstRow.className = "cm-tab-checkbox-row";
  const againstLabel = document.createElement("label");
  againstLabel.textContent = "Sweep against";
  againstRow.appendChild(againstLabel);
  const againstBody = document.createElement("div");
  againstBody.className = "cm-tab-checkbox-body";
  for (const opt of [
    { value: "post", label: "Post-fusion (citation-aware)",   checked: true  },
    { value: "pre",  label: "Pre-fusion (semantic-only)",     checked: false },
    { value: "both", label: "Both (compare side-by-side)",    checked: false },
  ]) {
    const lab = document.createElement("label");
    lab.className = "cm-tab-checkbox";
    const r = document.createElement("input");
    r.type = "radio";
    r.name = "sweep-against";
    r.value = opt.value;
    r.checked = opt.checked;
    r.addEventListener("change", () => { if (r.checked) sweepAgainst = opt.value; });
    lab.appendChild(r);
    const span = document.createElement("span");
    span.textContent = opt.label;
    lab.appendChild(span);
    againstBody.appendChild(lab);
  }
  againstRow.appendChild(againstBody);
  const againstHint = document.createElement("div");
  againstHint.className = "cm-tab-slider-hint cm-tab-checkbox-hint";
  againstHint.textContent = "Which dim-reduction to optimise against. Post-fusion = the UMAP that includes citation context; pre-fusion = the semantic-only baseline. 'Both' runs the sweep twice and tags each row's source — useful for asking 'does fusion change which params are most stable?'.";
  againstRow.appendChild(againstHint);
  targetPanel.appendChild(againstRow);

  // Show / hide the sweep-against row based on whether pre-fusion data
  // is available. When fusion is identity (toy mode default) there's
  // no pre-fusion buffer and the choice collapses to post-only — no
  // need to clutter the UI.
  function refreshSweepAgainstVisibility() {
    const hasPre = !!getState()._basePosPreFusion;
    againstRow.style.display = hasPre ? "" : "none";
    if (!hasPre && sweepAgainst !== "post") {
      sweepAgainst = "post";
      const postRadio = againstBody.querySelector('input[value="post"]');
      if (postRadio) postRadio.checked = true;
    }
  }
  refreshSweepAgainstVisibility();

  // Cluster-count range row (two number inputs).
  const rangeRow = document.createElement("div");
  rangeRow.className = "cm-tab-slider-row";
  const rangeLabel = document.createElement("label");
  rangeLabel.textContent = "Target clusters";
  rangeRow.appendChild(rangeLabel);
  const rangeBody = document.createElement("div");
  rangeBody.style.display = "flex";
  rangeBody.style.gap = "6px";
  rangeBody.style.alignItems = "center";
  const minInput = numberInput(targetMin, 1, 999, (v) => { targetMin = v; });
  const maxInput = numberInput(targetMax, 1, 999, (v) => { targetMax = v; });
  rangeBody.appendChild(minInput);
  const dash = document.createElement("span");
  dash.textContent = "to";
  dash.style.color = "var(--text-dim)";
  rangeBody.appendChild(dash);
  rangeBody.appendChild(maxInput);
  rangeRow.appendChild(rangeBody);
  const rangeHint = document.createElement("div");
  rangeHint.className = "cm-tab-slider-hint";
  rangeHint.textContent = "Sweep keeps configs producing this many clusters. Top results land in the middle of the band.";
  rangeRow.appendChild(rangeHint);
  targetPanel.appendChild(rangeRow);

  targetPanel.appendChild(slider("Phase-1 samples", 10, 100, 5, phase1Count, (v) => { phase1Count = v; },
    "How many parameter combinations to probe per algorithm in the broad first pass. Higher = better coverage but slower. 30 is fine at toy scale; 50-80 helps at BFS-5000."));

  targetPanel.appendChild(slider("Refine step", 0, 6, 1, refineStep, (v) => { refineStep = v; },
    "After Phase 1, each hit's resolution parameters are perturbed by ±N steps to refine. 0 = no refinement (Phase 1 only); 3 covers a small neighbourhood; 6 is generous. Higher values blow up config count fast."));

  const bootRow = document.createElement("div");
  bootRow.className = "cm-tab-checkbox-row";
  const bootCb = document.createElement("input");
  bootCb.type = "checkbox";
  bootCb.checked = targetBoot;
  bootCb.addEventListener("change", () => { targetBoot = bootCb.checked; });
  const bootLab = document.createElement("label");
  bootLab.className = "cm-tab-checkbox";
  bootLab.appendChild(bootCb);
  const bootSpan = document.createElement("span");
  bootSpan.textContent = "Rank by reproducibility (bootstrap)";
  bootLab.appendChild(bootSpan);
  bootRow.appendChild(bootLab);
  const bootHint = document.createElement("div");
  bootHint.className = "cm-tab-slider-hint cm-tab-checkbox-hint";
  bootHint.textContent = "Off (default): rank by closeness to the band's midpoint. Quick exploration — not a quality measure; treats every in-band config as equally good and just picks the one nearest the centre. On: bootstrap-Jaccard each Phase-2 candidate and rank by reproducibility. Slower (≈ B × per-config cost) but this is the metric you want when choosing a final config to commit to.";
  bootRow.appendChild(bootHint);
  targetPanel.appendChild(bootRow);

  settings.appendChild(targetPanel);

  const bootstrapsRow = slider("Bootstraps",  5, 30, 1, B, (v) => { B = v; },
    "Bootstrap iterations per config (only used when ranking by reproducibility or richness; ignored for other scorers). Lower for faster sweeps; 10 is a reasonable default.");
  settings.appendChild(bootstrapsRow);

  // §6.18.9 B8 — noise-handling dropdown. Affects bootstrap-based
  // scorers + target-range bootstrap; ignored by ARI / numClusters
  // (no bootstrap involved). Default "exclude" preserves the pre-
  // §6.18.9 behaviour.
  const noiseRow = document.createElement("div");
  noiseRow.className = "cm-tab-select-row";
  const noiseLabel = document.createElement("label");
  noiseLabel.textContent = "Noise handling";
  noiseRow.appendChild(noiseLabel);
  const noiseSelect = document.createElement("select");
  for (const opt of [
    { value: "exclude",   label: "Exclude noise (default)" },
    { value: "asCluster", label: "Treat noise as a cluster" },
    { value: "penalise",  label: "Penalise (scale by 1 − noise fraction)" },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value; o.textContent = opt.label;
    if (opt.value === noiseHandling) o.selected = true;
    noiseSelect.appendChild(o);
  }
  noiseSelect.addEventListener("change", () => { noiseHandling = noiseSelect.value; });
  noiseRow.appendChild(noiseSelect);
  const noiseHint = document.createElement("div");
  noiseHint.className = "cm-tab-slider-hint cm-tab-select-hint";
  noiseHint.textContent =
    "How -1 (noise) labels participate in the bootstrap-Jaccard score. " +
    "Exclude: silently drop noise points from both reference and bootstrap before matching — scores only the non-noise portion of the clustering. " +
    "Treat noise as a cluster: remap -1 to a synthetic 'noise cluster' id; noise-vs-noise then contributes to the bipartite match like any other cluster pair. Useful when comparing HDBSCAN modes where noiseMode = absorb vs singletons would otherwise score very differently for unrelated reasons. " +
    "Penalise: same matching as exclude, but the aggregate reproducibility numbers are multiplied by (1 − noise fraction) so a clustering that's 30% noise loses 30% of its stability score. Lets you compare clusterings with different noise levels on equal footing. " +
    "Scores under different modes are NOT directly comparable; pick a mode for a research question and stick to it.";
  noiseRow.appendChild(noiseHint);
  settings.appendChild(noiseRow);

  // Scorer dropdown — pluggable metric the sweep ranks by.
  const scorerRow = document.createElement("div");
  scorerRow.className = "cm-tab-select-row";
  const scorerLabel = document.createElement("label");
  scorerLabel.textContent = "Ranked by";
  scorerRow.appendChild(scorerLabel);
  const scorerSelect = document.createElement("select");

  // §6.18.10 B11 — drop "Automatic" in real-data mode; force an
  // explicit pick. Toy mode keeps Automatic since ARI vs ground
  // truth is the obvious answer. "Cluster richness" relabelled to
  // surface the trade-off ("Cluster count × reproducibility").
  // The dropdown is rebuilt when the data-source mode changes (via
  // the subscribe at the bottom of buildOptimiseTab) so toggling
  // toy ↔ real updates the available options without re-opening
  // the modal.
  const isRealMode = () => {
    const ds = getState().dataSource;
    return ds && ds.mode === "real";
  };
  function buildScorerOptions() {
    scorerSelect.innerHTML = "";
    const opts = [];
    if (!isRealMode()) opts.push({ value: "auto", label: "Automatic (ARI vs ground truth)" });
    opts.push({ value: "ari",         label: "Match to known groups (ARI)" });
    opts.push({ value: "richness",    label: "Cluster count × reproducibility" });
    opts.push({ value: "numClusters", label: "Number of clusters" });
    opts.push({ value: "stability",   label: "Cluster reproducibility (mean Jaccard)" });
    // If the previously-selected scorer is no longer available (e.g.
    // user picked "auto" then switched to real mode), fall back to
    // "richness" — the closest equivalent default for real data.
    if (!opts.some(o => o.value === scorerId)) scorerId = "richness";
    for (const opt of opts) {
      const o = document.createElement("option");
      o.value = opt.value; o.textContent = opt.label;
      if (opt.value === scorerId) o.selected = true;
      scorerSelect.appendChild(o);
    }
  }
  buildScorerOptions();
  scorerSelect.addEventListener("change", () => { scorerId = scorerSelect.value; });
  scorerRow.appendChild(scorerSelect);
  const scorerHint = document.createElement("div");
  scorerHint.className = "cm-tab-slider-hint cm-tab-select-hint";
  scorerHint.textContent =
    "Match to known groups compares your clustering against ground-truth labels — only works when those labels exist (e.g. the toy generator's origins; shown alongside the Bayes-optimal ceiling). " +
    "Cluster count × reproducibility multiplies cluster count by mean Jaccard — balanced across both extremes (one mega-cluster vs many noise-fragments). " +
    "Number of clusters ranks purely by how many groups the algorithm produced (informative when you trust the algorithm and want to push toward more clusters; doesn't filter out noise-fragmentation). " +
    "Cluster reproducibility re-clusters resampled data and asks how similar the partitions are — beware it rewards trivially-coarse partitions (a 1-cluster solution scores ~1.0). " +
    "In real-data mode (no ground truth) we don't auto-pick because each scorer answers a different question; pick the one matching your research aim.";
  scorerRow.appendChild(scorerHint);
  settings.appendChild(scorerRow);

  // Subscribe to state changes so toggling toy ↔ real refreshes the
  // available scorer options without forcing the user to close/reopen
  // the modal.
  let lastMode = getState().dataSource && getState().dataSource.mode;
  subscribe((state) => {
    const m = state.dataSource && state.dataSource.mode;
    if (m !== lastMode) {
      lastMode = m;
      buildScorerOptions();
    }
  });

  // Run row.
  const runRow = document.createElement("div");
  runRow.className = "cm-tab-runrow";
  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.className = "cm-tab-run";
  runBtn.textContent = "Run sweep";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "cm-tab-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.display = "none";
  const status = document.createElement("span");
  status.className = "cm-tab-status";
  runRow.appendChild(runBtn);
  runRow.appendChild(cancelBtn);
  runRow.appendChild(status);
  settings.appendChild(runRow);
  host.appendChild(settings);

  // Results section.
  const results = document.createElement("div");
  results.className = "cm-tab-section cm-tab-results";
  results.style.display = "none";
  host.appendChild(results);

  // Restore from state if a previous sweep is cached AND it was
  // produced under the current scoring protocol. §6.18.7d migration:
  // older caches (no scoreVersion or != SCORE_VERSION) are silently
  // discarded — the user gets a banner explaining the situation and
  // is asked to re-run. We don't try to upgrade the old format in
  // place because the numbers genuinely mean different things.
  const cachedOpt = getState().evalResults && getState().evalResults.optimise;
  if (cachedOpt && cachedOpt.ranked) {
    if (cachedOpt.scoreVersion === SCORE_VERSION) {
      renderResults(
        results,
        { ranked: cachedOpt.ranked, totalConfigs: cachedOpt.totalConfigs, completed: cachedOpt.completed },
        { id: cachedOpt.scorerId, label: cachedOpt.scorerLabel },
        onApplyRow,
        getLevels,
      );
      results.style.display = "";
      status.textContent = `cached · ${cachedOpt.totalConfigs} configs · ranked by ${cachedOpt.scorerLabel}`;
    } else {
      // Pre-§6.18.7 cache. Drop it on the floor and explain.
      try { setOptimiseResult(null); } catch (_) {}
      status.textContent = "Older optimise scores discarded — re-run to see scores under the current method (§6.18.7).";
    }
  }

  runBtn.addEventListener("click", async () => {
    const s = getState();
    if (!s.genResult || !s.dimredResult) {
      status.textContent = "Apply a clustering first.";
      return;
    }
    const algos = allAlgos.filter(a => enabled.get(a.id));
    if (algos.length === 0) { status.textContent = "Pick at least one algorithm."; return; }

    // Resolve the scorer for resolution/full modes. Target-range mode
    // has its own ranking (proximity or bootstrap mean-Jaccard) and
    // doesn't read scorerId at all.
    let scorer = null;
    if (sweepMode !== "target") {
      scorer = pickScorer(scorerId, s, B, noiseHandling);
      if (!scorer) { status.textContent = "ARI requires toy mode (no ground truth in real data)."; return; }
    }

    // Fresh AbortController per run (one-shot — once aborted, stays
    // aborted, so we can't reuse the previous run's controller).
    abortController = new AbortController();
    const signal = abortController.signal;

    runBtn.disabled = true;
    runBtn.textContent = "Running…";
    runBtn.classList.add("running");
    cancelBtn.style.display = "";
    status.textContent = `0 / ?`;
    results.style.display = "none";
    results.innerHTML = "";

    const t0 = performance.now();
    let outcome = null;
    try {
      if (sweepMode === "target") {
        if (!(targetMax >= targetMin && targetMin >= 1)) {
          status.textContent = `invalid range [${targetMin}, ${targetMax}]`;
          runBtn.disabled = false;
          runBtn.textContent = "Run sweep";
          runBtn.classList.remove("running");
          cancelBtn.style.display = "none";
          return;
        }
        // Resolve which dim-reduction(s) the sweep targets. When the
        // user picked "Both", we run twice and merge — tagging every
        // row by source so the unified table is readable.
        const hasPre = !!s.dimredResultPreFusion;
        const effectiveAgainst = (sweepAgainst !== "post" && !hasPre) ? "post" : sweepAgainst;
        const passes = effectiveAgainst === "both"
          ? [
              { tag: "post", dimred: s.dimredResult },
              { tag: "pre",  dimred: s.dimredResultPreFusion },
            ]
          : effectiveAgainst === "pre"
            ? [{ tag: "pre",  dimred: s.dimredResultPreFusion }]
            : [{ tag: "post", dimred: s.dimredResult }];

        const mergedRanked = [];
        const mergedPhase1 = [];
        const mergedPhase2 = [];
        let mergedHitCount = 0;
        let mergedUsedFallback = false;
        for (let pi = 0; pi < passes.length; pi++) {
          if (signal.aborted) break;
          const pass = passes[pi];
          const subOutcome = await runTargetRangeSweep({
            algorithms:   algos,
            genResult:    s.genResult,
            dimredResult: pass.dimred,
            n:            s.genResult.nodes.length,
            targetMin, targetMax,
            phase1Count, refineStep,
            runBootstrap: targetBoot,
            // Inherit the bootstrap defaults from bootstrap.js (frac=0.5
            // post-§6.18.7, minMembers=3 post-§6.18.9); explicit override
            // would shadow that. noiseHandling carries the user's pick
            // from the Optimise settings dropdown.
            bootstrapOpts:{ B, noiseHandling },
            // Distinct seed per pass so the LHS samples don't collide
            // on identical configs across the two passes.
            seed:         42 + (pi * 1009),
            onProgress: (phase, i, total, label) => {
              const passLabel = passes.length > 1 ? `[${pass.tag}] ` : "";
              status.textContent = `${passLabel}${phase} · ${i} / ${total} · ${label}`;
            },
            abortSignal: signal,
          });
          // Tag each row + section with the pass it came from. Same
          // tag also lands on the cached settings so the renderer can
          // show a Source column when passes.length > 1.
          for (const r of subOutcome.ranked) r.source = pass.tag;
          for (const e of subOutcome.phase1) e.source = pass.tag;
          for (const e of subOutcome.phase2) e.source = pass.tag;
          mergedRanked.push(...subOutcome.ranked);
          mergedPhase1.push(...subOutcome.phase1);
          mergedPhase2.push(...subOutcome.phase2);
          mergedHitCount     += subOutcome.hitCount || 0;
          mergedUsedFallback = mergedUsedFallback || !!subOutcome.usedFallback;
        }
        // Re-rank the merged ranked list with the same comparator
        // runTargetRangeSweep uses (in-range first, then primary desc).
        mergedRanked.sort((a, b) => {
          if (a.inRange !== b.inRange) return a.inRange ? -1 : 1;
          const ap = Number.isFinite(a.primary) ? a.primary : -Infinity;
          const bp = Number.isFinite(b.primary) ? b.primary : -Infinity;
          if (bp !== ap) return bp - ap;
          return (b.secondary || 0) - (a.secondary || 0);
        });
        outcome = {
          ranked:       mergedRanked,
          phase1:       mergedPhase1,
          phase2:       mergedPhase2,
          hitCount:     mergedHitCount,
          usedFallback: mergedUsedFallback,
          totalConfigs: mergedPhase1.length + mergedPhase2.length,
          completed:    mergedPhase1.length + mergedPhase2.length,
          // Pass the effective sweep-against down so the renderer can
          // decide whether to show the Source column.
          _sweepAgainst: effectiveAgainst,
        };
      } else {
        outcome = await sweepAcrossAlgorithms({
          algorithms:    algos,
          genResult:     s.genResult,
          dimredResult:  s.dimredResult,
          scorer,
          resolutionOnly: (sweepMode === "resolution"),
          onProgress: (i, total, label) => { status.textContent = `${i} / ${total} · ${label}`; },
          abortSignal: signal,
        });
      }
    } catch (e) {
      console.error("[optimise-tab] sweep threw:", e);
      status.textContent = "error — see console";
    }

    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    if (outcome) {
      // Synthesise a "scorer" label for target-range runs so the cached
      // header text reads sensibly when the user hops away and back.
      const effectiveScorer = sweepMode === "target"
        ? { id: targetBoot ? "target+bootstrap" : "target", label: targetBoot ? "target range + reproducibility" : "target range (proximity)" }
        : scorer;
      // Cache into state so the table survives tab hops + project saves.
      // Strip `_cr` from each row before persisting — it's a runtime-only
      // cache (A3, §6.18.3) holding Int32Arrays that don't round-trip
      // cleanly through the .zip serializer. The live `outcome.ranked`
      // keeps `_cr` for the apply-button click handler this session;
      // restoring from cache after a reload loses the optimisation and
      // falls back to re-infer on Apply, which is acceptable.
      const persistedRanked = outcome.ranked.map(r => {
        const { _cr, ...rest } = r;
        return rest;
      });
      setOptimiseResult({
        // §6.18.7d — stamp the bootstrap protocol version. On reload
        // we discard caches that don't match SCORE_VERSION so the user
        // never compares apples (v1) against oranges (v2).
        scoreVersion: SCORE_VERSION,
        ranked:       persistedRanked,
        totalConfigs: outcome.totalConfigs,
        completed:    outcome.completed,
        scorerId:     effectiveScorer.id,
        scorerLabel:  effectiveScorer.label,
        settings:     {
          B, scorerId, sweepMode, noiseHandling, algorithms: algos.map(a => a.id),
          ...(sweepMode === "target"
            ? {
                targetMin, targetMax, phase1Count, refineStep,
                runBootstrap: targetBoot,
                sweepAgainst: outcome._sweepAgainst || sweepAgainst,
              }
            : {}),
        },
        runtimeSec:   parseFloat(dt),
        timestamp:    new Date().toISOString(),
      });
      renderResults(results, outcome, effectiveScorer, onApplyRow, getLevels);
      results.style.display = "";
      const againstSuffix = (sweepMode === "target" && outcome._sweepAgainst === "both")
        ? " · both fusion sources"
        : (sweepMode === "target" && outcome._sweepAgainst === "pre")
          ? " · pre-fusion"
          : "";
      // Status suffix for target-range: report hit count + band, plus
      // a "refined N closest (no hits)" note when B12's fallback fired
      // so the user knows the table isn't from in-band configs.
      const phaseSuffix = sweepMode === "target"
        ? (outcome.usedFallback
            ? ` · no hits in [${targetMin}, ${targetMax}] — refined the closest Phase-1 configs${againstSuffix}`
            : ` · ${outcome.hitCount || 0} hits in [${targetMin}, ${targetMax}]${againstSuffix}`)
        : "";
      // §6.18.10 B6 — distribution stats so the user reads the
      // "best of N" with appropriate scepticism. "best 0.78 ·
      // median 0.42 · sd 0.18" tells a much clearer story than just
      // "best 0.78", which the user might read as "this is good"
      // without seeing the spread.
      const distSuffix = formatDistributionStats(outcome.ranked);
      status.textContent = signal.aborted
        ? `cancelled · ${outcome.completed} / ${outcome.totalConfigs} configs · ${dt}s${phaseSuffix}${distSuffix}`
        : `${outcome.totalConfigs} configs in ${dt}s · ranked by ${effectiveScorer.label}${phaseSuffix}${distSuffix}`;

      // §6.19.2 — Save-this-run button. Lets the user persist this
      // outcome as a ValidationRun that survives project save/load
      // and can be re-opened later from a panel without re-running
      // the sweep. Stashed on the run row (.cm-tab-runrow), shown
      // only after a successful sweep (not on cancellation or error).
      if (!signal.aborted && outcome.ranked && outcome.ranked.length > 0) {
        showSaveRunButton(runRow, outcome, persistedRanked, effectiveScorer,
                          algos, B, scorerId, sweepMode, noiseHandling,
                          sweepMode === "target"
                            ? { targetMin, targetMax, phase1Count, refineStep,
                                runBootstrap: targetBoot,
                                sweepAgainst: outcome._sweepAgainst || sweepAgainst }
                            : {},
                          parseFloat(dt));
      }
    }

    runBtn.disabled = false;
    runBtn.textContent = "Run sweep";
    runBtn.classList.remove("running");
    cancelBtn.style.display = "none";
  });

  cancelBtn.addEventListener("click", cancelCurrentRun);

  return {
    onTabHidden: cancelCurrentRun,
  };
}

// Pick the active scorer based on user choice + data-source mode.
// Returns null when the chosen scorer is unsupported (e.g. ARI under
// real mode where there's no ground truth).
function pickScorer(scorerId, state, B, noiseHandling) {
  const isReal = state.dataSource && state.dataSource.mode === "real";
  const bootOpts = { B, noiseHandling };
  if (scorerId === "auto") {
    // Toy → ARI (ground truth available). Real → cluster richness
    // (balanced metric — count × reproducibility — chosen as default
    // after the stability-alone scorer over-rewarded trivial coarse
    // partitions).
    return isReal ? clusterRichnessScorer(bootOpts) : ariScorer(extractGroundTruth(state));
  }
  if (scorerId === "richness")    return clusterRichnessScorer(bootOpts);
  if (scorerId === "numClusters") return numClustersScorer();
  if (scorerId === "stability")   return stabilityScorer(bootOpts);
  if (scorerId === "ari") {
    if (isReal) return null;
    return ariScorer(extractGroundTruth(state));
  }
  return null;
}

function extractGroundTruth(state) {
  const nodes = state.genResult && state.genResult.nodes;
  if (!nodes) return null;
  const gt = new Int32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const oid = nodes[i].originId;
    gt[i] = (oid == null) ? -1 : oid;
  }
  return gt;
}

// renderResults + scorer column logic + cell formatters now live in
// optimise-results-renderer.js so the §6.19 validation-run-optimise
// panel can share them without coupling the panel to the modal.
// Kept locally below: formatDistributionStats (status-line-only).

// §6.18.10 B6 — distribution stats for the sweep's primary scores.
// Reads "  ·  best 0.78 · median 0.42 · sd 0.18 · n 27" (or empty
// when fewer than 2 finite values — stats wouldn't be meaningful).
// The aim is honest disclosure: "best of N" cherry-picks, and the
// user should see the variance to read the headline appropriately.
// §6.19.2 — render a "Save this run" button into the run row after
// a sweep completes. Click prompts for a label (auto-suggested);
// confirm calls saveValidationRun() with a typed entry that travels
// with the project archive.
//
// The persisted run stores the same `persistedRanked` rows that
// setOptimiseResult took (i.e. with `_cr` already stripped per
// §6.18.3) — so v1 saves are compact but per-row Apply on a reload
// will re-infer, not skip-infer. cr persistence is a follow-up.
function showSaveRunButton(runRow, outcome, persistedRanked, scorer,
                            algos, B, scorerId, sweepMode, noiseHandling,
                            extraSettings, runtimeSec) {
  // Remove any previous save button (e.g. from an earlier sweep this
  // session — we re-create after every run so it tracks the latest).
  const existing = runRow.querySelector(".cm-tab-save-run");
  if (existing) existing.remove();

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "cm-tab-save-run";
  btn.textContent = "Save this run";
  btn.title = "Save this sweep as a Validation run — it survives a project reload and is openable later from the panel picker.";

  btn.addEventListener("click", () => {
    const state = getState();
    const ds    = state.dataSource;
    const mode  = (ds && ds.mode) || "toy";
    const cfg   = (ds && ds.configs && ds.configs[mode]) || {};

    // Auto-suggest a label from sweep shape + data fixture. The user
    // can edit before confirming.
    const subsetTag = mode === "real" ? (cfg.subset || "real") : `toy n=${state.genResult ? state.genResult.nodes.length : "?"}`;
    const algoTag   = algos.length === 1 ? algos[0].id : `${algos.length} algos`;
    const dateTag   = new Date().toISOString().slice(0, 10);
    const auto      = `${algoTag} · ${sweepMode} · ${subsetTag} · ${dateTag}`;

    const label = window.prompt("Label for this validation run:", auto);
    if (label === null) return;   // user cancelled

    try {
      const id = saveValidationRun({
        type: "optimise",
        label: label.trim() || auto,
        inputs: {
          dataSourceId:        mode,
          dataSourceConfig:    cfg,
          layerParamsSnapshot: state.layerParams,
        },
        settings: {
          B, scorerId, sweepMode, noiseHandling,
          algorithms: algos.map(a => a.id),
          ...extraSettings,
        },
        results: {
          ranked:       persistedRanked,
          totalConfigs: outcome.totalConfigs,
          completed:    outcome.completed,
          scorerId:     scorer.id,
          scorerLabel:  scorer.label,
          hitCount:     outcome.hitCount,
          usedFallback: outcome.usedFallback,
          phase2CacheHits: outcome.phase2CacheHits,
        },
        scoreVersion: SCORE_VERSION,
        runtimeSec,
      });
      btn.textContent = "Saved ✓";
      btn.disabled = true;
      // Reset after a moment so re-saves are visible.
      setTimeout(() => { btn.textContent = "Save again"; btn.disabled = false; }, 1500);
      console.log("[optimise] saved validation run:", id);
    } catch (e) {
      console.error("[optimise] saveValidationRun failed:", e);
      btn.textContent = "Save failed — see console";
    }
  });

  runRow.appendChild(btn);
}

function formatDistributionStats(ranked) {
  if (!ranked || ranked.length < 2) return "";
  const vals = ranked
    .map(r => r.primary)
    .filter(v => Number.isFinite(v));
  if (vals.length < 2) return "";
  const sorted = vals.slice().sort((a, b) => a - b);
  const best   = sorted[sorted.length - 1];
  const mid    = sorted[Math.floor(sorted.length / 2)];
  let sum = 0;
  for (const v of vals) sum += v;
  const mean = sum / vals.length;
  let sqsum = 0;
  for (const v of vals) sqsum += (v - mean) * (v - mean);
  const sd = Math.sqrt(sqsum / vals.length);
  return ` · best ${formatScalar(best)} · median ${formatScalar(mid)} · sd ${formatScalar(sd)} · n ${vals.length}`;
}

function slider(labelText, min, max, step, init, onInput, hint) {
  const row = document.createElement("div");
  row.className = "cm-tab-slider-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  row.appendChild(lab);
  const input = document.createElement("input");
  input.type = "range";
  input.min  = String(min);
  input.max  = String(max);
  input.step = String(step);
  input.value = String(init);
  row.appendChild(input);
  const readout = document.createElement("span");
  readout.className = "cm-tab-slider-readout";
  readout.textContent = String(init);
  row.appendChild(readout);
  if (hint) {
    const h = document.createElement("div");
    h.className = "cm-tab-slider-hint";
    h.textContent = hint;
    row.appendChild(h);
  }
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    readout.textContent = String(v);
    onInput(v);
  });
  return row;
}

// Small number-input helper used by the target-range cluster-count
// inputs (two side-by-side fields, no slider — exact values matter).
function numberInput(initial, min, max, onChange) {
  const inp = document.createElement("input");
  inp.type = "number";
  inp.min = String(min);
  inp.max = String(max);
  inp.value = String(initial);
  inp.style.width = "70px";
  inp.style.padding = "2px 4px";
  inp.style.background = "var(--bg-2)";
  inp.style.color = "var(--text)";
  inp.style.border = "1px solid var(--bg-3)";
  inp.style.borderRadius = "3px";
  inp.style.fontFamily = "inherit";
  inp.style.fontSize = "inherit";
  inp.addEventListener("change", () => {
    let v = parseInt(inp.value, 10);
    if (!Number.isFinite(v)) v = initial;
    if (v < min) v = min;
    if (v > max) v = max;
    inp.value = String(v);
    onChange(v);
  });
  return inp;
}
