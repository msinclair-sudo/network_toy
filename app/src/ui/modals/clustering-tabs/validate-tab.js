// Validate tab — runs bootstrap-Jaccard on the currently-applied
// clustering and shows per-cluster stability scores.
//
// Operates on state.clusterResult (the applied finest level), NOT on
// pending edits in the Configure tab. A small notice at the top makes
// that explicit so the user doesn't get confused when their pending
// param changes don't reflect here.
//
// The tab is rebuilt every time it's opened — keeps state minimal,
// modal close-and-reopen is the reset.

import { getState, setSelection, setValidateResult } from "../../state.js";
import { bootstrapStability, HENNIG_STABLE, HENNIG_DOUBTFUL } from "../../../eval/bootstrap.js";
import { getAlgorithm as getClusteringAlgorithm } from "../../../clustering-registry.js";

export function buildValidateTab(host) {
  const abortSignal = { aborted: false };
  let lastResult = null;

  // Restore from state if a previous run is cached (re-opened tab,
  // or just-loaded project file).
  const cached = getState().evalResults && getState().evalResults.validate;

  // ── notice strip ────────────────────────────────────────────────
  const notice = document.createElement("div");
  notice.className = "cm-tab-notice";
  notice.textContent = "Tests how reproducible your current clustering is when the data is resampled. To test a different config, switch to Configure and Apply first.";
  host.appendChild(notice);

  // ── settings panel ──────────────────────────────────────────────
  const settings = document.createElement("div");
  settings.className = "cm-tab-section";
  const settingsTitle = document.createElement("h4");
  settingsTitle.className = "cm-tab-section-title";
  settingsTitle.textContent = "Settings";
  settings.appendChild(settingsTitle);

  let B = 25;
  let subsampleFrac = 0.8;

  settings.appendChild(slider("Bootstraps",  5, 50, 1, B, (v) => { B = v; }, "How many resampled re-clusterings to run. More iterations = more confident scores, longer wait."));
  settings.appendChild(slider("Subsample %", 50, 100, 5, Math.round(subsampleFrac * 100), (v) => { subsampleFrac = v / 100; }, "What fraction of nodes each bootstrap iteration uses. 80% is the standard."));

  // ── run row ─────────────────────────────────────────────────────
  const runRow = document.createElement("div");
  runRow.className = "cm-tab-runrow";
  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.className = "cm-tab-run";
  runBtn.textContent = "Run validation";
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

  // ── results section (filled after run) ──────────────────────────
  const results = document.createElement("div");
  results.className = "cm-tab-section cm-tab-results";
  results.style.display = "none";
  host.appendChild(results);

  // If a cached result exists in state, hydrate the table immediately.
  if (cached && cached.perCluster) {
    lastResult = cached;
    renderResults(results, cached);
    results.style.display = "";
    status.textContent = `cached · ${cached.bootstrapsRun} bootstraps`;
    if (cached.settings) {
      // Restore the slider readouts so the settings panel reflects
      // what the cached result was run with.
      B = cached.settings.B;
      subsampleFrac = cached.settings.subsampleFrac;
    }
  }

  runBtn.addEventListener("click", async () => {
    const s = getState();
    if (!s.clusterResult || !s.genResult || !s.dimredResult) {
      status.textContent = "Apply a clustering first.";
      return;
    }
    const algo = getClusteringAlgorithm(s.layerParams.clustering.method);
    // Use the finest level's params as the bootstrap config.
    const finestLevel = s.clusterLevels[s.clusterLevels.length - 1];
    const params = finestLevel ? finestLevel.params : algo.defaultParams();

    abortSignal.aborted = false;
    runBtn.disabled = true;
    runBtn.textContent = "Running…";
    runBtn.classList.add("running");
    cancelBtn.style.display = "";
    status.textContent = `0 / ${B}`;
    results.style.display = "none";
    results.innerHTML = "";

    let onProgress = (i, total) => { status.textContent = `${i} / ${total}`; };
    try {
      const r = await bootstrapStability({
        refClusterResult: s.clusterResult,
        genResult:        s.genResult,
        dimredResult:     s.dimredResult,
        algo, params,
        B, subsampleFrac,
        seed: 12345,
        onProgress,
        abortSignal,
      });
      // Persist into state so the result survives tab close, hops to
      // a different tab and back, or a project save/reload.
      lastResult = {
        ...r,
        settings:  { B, subsampleFrac, seed: 12345 },
        timestamp: new Date().toISOString(),
      };
      setValidateResult(lastResult);
      renderResults(results, lastResult);
      results.style.display = "";
      status.textContent = abortSignal.aborted
        ? `cancelled at ${lastResult.bootstrapsRun}/${B}`
        : `done · ${lastResult.bootstrapsRun} bootstraps`;
    } catch (e) {
      console.error("[validate-tab] bootstrap threw:", e);
      status.textContent = "error — see console";
    } finally {
      runBtn.disabled = false;
      runBtn.textContent = "Run validation";
      runBtn.classList.remove("running");
      cancelBtn.style.display = "none";
    }
  });

  cancelBtn.addEventListener("click", () => {
    abortSignal.aborted = true;
  });

  return {
    onTabHidden() { abortSignal.aborted = true; },
  };
}

function renderResults(host, result) {
  host.innerHTML = "";

  // Headline aggregate.
  const head = document.createElement("h4");
  head.className = "cm-tab-section-title";
  head.textContent = "Results";
  host.appendChild(head);

  const agg = result.aggregate;
  const aggLine = document.createElement("div");
  aggLine.className = "cm-tab-aggregate";
  aggLine.innerHTML = `
    <span class="cm-tab-stat stable"><b>${agg.nStable}</b> / ${agg.nClusters} stable (${pct(agg.fractionStable)})</span>
    <span class="cm-tab-stat doubtful"><b>${agg.nDoubtful}</b> doubtful</span>
    <span class="cm-tab-stat unstable"><b>${agg.nUnstable}</b> unstable</span>
    <span class="cm-tab-stat-meanj">Mean Jaccard: <b>${agg.meanJaccard.toFixed(3)}</b></span>
  `;
  host.appendChild(aggLine);

  // Per-cluster table, sorted desc by score.
  const sorted = result.perCluster.slice().sort((a, b) => b.meanJaccard - a.meanJaccard);
  const table = document.createElement("table");
  table.className = "cm-tab-table";
  table.innerHTML = `
    <thead>
      <tr>
        <th>id</th><th>count</th><th>Jaccard</th><th>score</th><th>verdict</th>
      </tr>
    </thead>
  `;
  const tbody = document.createElement("tbody");
  for (const p of sorted) {
    const tr = document.createElement("tr");
    tr.className = `cm-tab-row verdict-${p.classification}`;
    tr.dataset.clusterId = p.clusterId;
    tr.innerHTML = `
      <td>${p.clusterId}</td>
      <td>${p.memberCount}</td>
      <td>${p.meanJaccard.toFixed(3)}</td>
      <td><div class="cm-tab-bar"><div class="cm-tab-bar-fill" style="width:${(p.meanJaccard * 100).toFixed(0)}%"></div></div></td>
      <td><span class="cm-tab-verdict verdict-${p.classification}">${p.classification}</span></td>
    `;
    tr.addEventListener("click", () => {
      // Select the cluster in the viewer. Finest level — that's what
      // we validated.
      const s = getState();
      const finestIdx = (s.clusterLevels || []).length - 1;
      if (finestIdx >= 0) {
        setSelection({ type: "cluster", level: finestIdx, id: p.clusterId });
      }
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);

  const legend = document.createElement("div");
  legend.className = "cm-tab-legend";
  legend.innerHTML = `
    <span><i class="cm-tab-swatch verdict-stable"></i> stable ≥ ${HENNIG_STABLE.toFixed(2)}</span>
    <span><i class="cm-tab-swatch verdict-doubtful"></i> doubtful ${HENNIG_DOUBTFUL.toFixed(2)}–${HENNIG_STABLE.toFixed(2)}</span>
    <span><i class="cm-tab-swatch verdict-unstable"></i> unstable &lt; ${HENNIG_DOUBTFUL.toFixed(2)}</span>
  `;
  host.appendChild(legend);
}

function pct(x) { return `${(x * 100).toFixed(0)}%`; }

function slider(labelText, min, max, step, init, onInput, hint) {
  const row = document.createElement("div");
  row.className = "cm-tab-slider-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  row.appendChild(lab);
  const input = document.createElement("input");
  input.type  = "range";
  input.min   = String(min);
  input.max   = String(max);
  input.step  = String(step);
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
