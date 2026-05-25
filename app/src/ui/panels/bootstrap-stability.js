// Panel: bootstrap stability (live or saved).
//
// Two modes selected by `config.runId`:
//   - **Live** (no runId): user picks B / subsampleFrac /
//     noiseHandling / minMembers, clicks Run; the panel calls
//     bootstrapStability against the currently-applied clustering;
//     results render in-place; a Save-this-run button appears so
//     the result can be archived as a ValidationRun.
//   - **Saved** (runId set): read-only render of the matching
//     state.validationRuns entry. No Run / Save buttons; the
//     header carries the saved label + inputs snapshot.
//
// Replaces the use case the deleted Validate tab (§6.18.1) used to
// host, but as a pinnable panel rather than a modal-bound tab.
//
// Uses the same bootstrap engine that powers the Optimise tab's
// richness / stability scorers, so the protocol details (subsampling
// without replacement at frac=0.5, bipartite-matched Jaccard,
// minMembers≥3) are consistent across the app.

import {
  getState, subscribe, saveValidationRun, setSelection,
} from "../state.js";
import { bootstrapStability, SCORE_VERSION, DEFAULT_MIN_MEMBERS,
         HENNIG_STABLE, HENNIG_DOUBTFUL }
  from "../../eval/bootstrap.js";
import { getAlgorithm as getClusteringAlgo }  from "../../clustering-registry.js";

export const ID          = "bootstrap-stability";
export const LABEL       = "Bootstrap stability";
export const DESCRIPTION = "Run bootstrap-Jaccard stability against the currently-applied clustering (live), or render a saved run. Per-cluster bars + Hennig breakdown + macro / unweighted aggregates.";
export const SINGLETON   = true;

export function mount(container, _state, config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-bs";
  container.appendChild(wrap);

  const runId = (config && config.runId) || null;
  const liveMode = !runId;

  // Live-mode state. Saved-mode reads everything off the bound run.
  let liveConfig = {
    B:             10,
    subsampleFrac: 0.5,
    noiseHandling: "exclude",
    minMembers:    DEFAULT_MIN_MEMBERS,
  };
  let liveResult = null;          // last bootstrap result; rendered + savable
  let abortController = null;
  let isRunning = false;
  // Sentinel: undefined means "not yet rendered" (null collides with
  // findSavedRun's "not found" return value, which would skip the
  // initial empty-state render).
  let lastSavedRunRef = undefined;

  function findSavedRun() {
    if (liveMode) return null;
    const runs = getState().validationRuns || [];
    return runs.find(r => r.id === runId) || null;
  }

  function render() {
    if (!liveMode) {
      // Saved mode — re-render only when the bound run reference
      // changes (otherwise every state tick would clobber the DOM
      // unnecessarily).
      const r = findSavedRun();
      if (r === lastSavedRunRef) return;
      lastSavedRunRef = r;
    }

    wrap.innerHTML = "";

    // Header.
    const header = document.createElement("div");
    header.className = "panel-bs-header";
    const title = document.createElement("div");
    title.className = "panel-bs-title";
    const sub = document.createElement("div");
    sub.className = "panel-bs-meta";
    header.appendChild(title);
    header.appendChild(sub);
    wrap.appendChild(header);

    if (liveMode) {
      // Title shows what we're running against; meta is empty.
      const cur = currentClusteringSummary();
      if (!cur) {
        title.textContent = "Bootstrap stability";
        const empty = document.createElement("div");
        empty.className = "panel-bs-empty";
        empty.textContent = "Apply a clustering first (Clustering modal → Configure → Apply), then return here to run a bootstrap.";
        wrap.appendChild(empty);
        return;
      }
      title.textContent = `Bootstrap stability — ${cur.label} (${cur.nClusters} clusters)`;
      renderLiveBody(cur);
    } else {
      const run = findSavedRun();
      if (!run) {
        title.textContent = "Bootstrap stability — saved";
        const empty = document.createElement("div");
        empty.className = "panel-bs-empty";
        empty.textContent = "This saved run no longer exists. Open the panel picker (+) to choose another.";
        wrap.appendChild(empty);
        return;
      }
      title.textContent = run.label || "(unlabelled bootstrap run)";
      sub.textContent = formatSavedMeta(run);
      renderSavedBody(run);
    }
  }

  // ── LIVE MODE ──
  function renderLiveBody(cur) {
    // Config row.
    const cfgRow = document.createElement("div");
    cfgRow.className = "panel-bs-cfg";
    cfgRow.appendChild(
      makeSlider("B", 5, 50, 1, liveConfig.B, (v) => { liveConfig.B = v; },
        "Bootstrap iterations. Hennig 2007 used 50; 10–25 is a working minimum.")
    );
    cfgRow.appendChild(
      makeSlider("subsampleFrac", 0.3, 0.9, 0.05, liveConfig.subsampleFrac, (v) => { liveConfig.subsampleFrac = v; },
        "Fraction of nodes resampled (without replacement) per iter. Hennig 2008 recommends 0.5.")
    );
    cfgRow.appendChild(
      makeNumber("minMembers", 1, 50, liveConfig.minMembers, (v) => { liveConfig.minMembers = v; },
        "Drop reference clusters with fewer than N in-subsample members from per-iter scoring (Hennig 2007 §3.2).")
    );
    cfgRow.appendChild(
      makeSelect("Noise handling", liveConfig.noiseHandling, [
        { value: "exclude",   label: "Exclude noise" },
        { value: "asCluster", label: "Treat noise as a cluster" },
        { value: "penalise",  label: "Penalise (× 1 − noise fraction)" },
      ], (v) => { liveConfig.noiseHandling = v; },
        "How -1 labels participate. Scores under different modes are not directly comparable.")
    );
    wrap.appendChild(cfgRow);

    // Run row.
    const runRow = document.createElement("div");
    runRow.className = "panel-bs-runrow";
    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "panel-bs-run";
    runBtn.textContent = isRunning ? "Running…" : "Run bootstrap";
    runBtn.disabled = isRunning;
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "panel-bs-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.display = isRunning ? "" : "none";
    const status = document.createElement("span");
    status.className = "panel-bs-status";
    runRow.appendChild(runBtn);
    runRow.appendChild(cancelBtn);
    runRow.appendChild(status);
    wrap.appendChild(runRow);

    runBtn.addEventListener("click", async () => {
      const s = getState();
      const algo = getClusteringAlgo(s.layerParams.clustering.method);
      const refCr = s.clusterLevels[0].clusterResult;
      const refParams = s.layerParams.clustering.levels[0].params;

      abortController = new AbortController();
      isRunning = true;
      runBtn.disabled = true;
      runBtn.textContent = "Running…";
      cancelBtn.style.display = "";
      status.textContent = "0 / " + liveConfig.B;

      const t0 = performance.now();
      try {
        const result = await bootstrapStability({
          refClusterResult: refCr,
          genResult:        s.genResult,
          dimredResult:     s.dimredResult,
          algo,
          params:           refParams,
          B:                liveConfig.B,
          subsampleFrac:    liveConfig.subsampleFrac,
          minMembers:       liveConfig.minMembers,
          noiseHandling:    liveConfig.noiseHandling,
          seed:             12345,
          onProgress:       (it, total) => { status.textContent = `${it} / ${total}`; },
          abortSignal:      abortController.signal,
        });
        const dt = (performance.now() - t0) / 1000;
        liveResult = { result, runtimeSec: dt, ranAt: new Date().toISOString() };
        status.textContent = abortController.signal.aborted
          ? `cancelled · ${result.bootstrapsRun} / ${liveConfig.B} iters · ${dt.toFixed(1)}s`
          : `${result.bootstrapsRun} iters · ${dt.toFixed(1)}s`;
      } catch (e) {
        if (e && e.name === "AbortError") {
          status.textContent = "cancelled";
        } else {
          console.error("[bootstrap-stability panel] bootstrap failed:", e);
          status.textContent = `error: ${e.message || e}`;
        }
      }
      isRunning = false;
      runBtn.disabled = false;
      runBtn.textContent = "Run bootstrap";
      cancelBtn.style.display = "none";
      renderResultsArea(cur);
    });
    cancelBtn.addEventListener("click", () => {
      if (abortController) abortController.abort();
    });

    // Results area (populated after a run).
    const results = document.createElement("div");
    results.className = "panel-bs-results";
    wrap.appendChild(results);
    renderResultsArea(cur);

    function renderResultsArea(curSummary) {
      results.innerHTML = "";
      if (!liveResult) return;
      renderResultBody(results, liveResult.result, curSummary, liveResult.runtimeSec, /*savable=*/ true);
    }
  }

  // ── SAVED MODE ──
  function renderSavedBody(run) {
    const cur = {
      label:     run.results.cluster && run.results.cluster.label || "saved clustering",
      algoId:    run.inputs && run.inputs.layerParamsSnapshot && run.inputs.layerParamsSnapshot.clustering && run.inputs.layerParamsSnapshot.clustering.method,
      nClusters: run.results.aggregate && run.results.aggregate.nClusters,
    };
    const body = document.createElement("div");
    body.className = "panel-bs-results";
    wrap.appendChild(body);
    renderResultBody(body, run.results.bootstrapResult, cur, run.runtimeSec, /*savable=*/ false);
  }

  // ── shared results renderer ──
  function renderResultBody(host, br, curSummary, runtimeSec, savable) {
    const agg = br.aggregate;
    if (!agg || !Array.isArray(br.perCluster)) {
      const empty = document.createElement("div");
      empty.className = "panel-bs-empty";
      empty.textContent = "(empty result)";
      host.appendChild(empty);
      return;
    }

    // Aggregate strip.
    const aggRow = document.createElement("div");
    aggRow.className = "panel-bs-agg";
    aggRow.innerHTML = `
      <span><b>macro</b> ${fmtScalar(agg.meanJaccard_macro)}</span>
      <span><b>per-cluster</b> ${fmtScalar(agg.meanJaccard_unweighted)}</span>
      <span><b>nClusters</b> ${agg.nClusters}</span>
      <span><b>noise frac</b> ${fmtScalar(agg.noiseFraction)}</span>
      <span><b>protocol</b> ${agg.noiseHandling || "exclude"}</span>
    `;
    host.appendChild(aggRow);

    // Hennig breakdown bar — same widget as the Optimise table.
    const total = agg.nStable + agg.nDoubtful + agg.nUnstable;
    if (total > 0) {
      const bar = document.createElement("div");
      bar.className = "panel-bs-breakdown";
      const s = (agg.nStable   / total) * 100;
      const d = (agg.nDoubtful / total) * 100;
      const u = (agg.nUnstable / total) * 100;
      bar.innerHTML = `
        <span class="cm-hennig-bar" title="${agg.nStable} stable · ${agg.nDoubtful} doubtful · ${agg.nUnstable} unstable (Hennig: stable ≥ ${HENNIG_STABLE}, doubtful ${HENNIG_DOUBTFUL}–${HENNIG_STABLE}, unstable < ${HENNIG_DOUBTFUL})">
          <span class="cm-hennig-seg cm-hennig-stable"   style="width:${s.toFixed(2)}%"></span>
          <span class="cm-hennig-seg cm-hennig-doubtful" style="width:${d.toFixed(2)}%"></span>
          <span class="cm-hennig-seg cm-hennig-unstable" style="width:${u.toFixed(2)}%"></span>
        </span>
        <span class="panel-bs-breakdown-counts">
          ${agg.nStable} stable · ${agg.nDoubtful} doubtful · ${agg.nUnstable} unstable
        </span>
      `;
      host.appendChild(bar);
    }

    // Per-cluster table.
    const table = document.createElement("table");
    table.className = "panel-bs-table";
    host.appendChild(table);

    let sortKey = "meanJaccard";
    let sortDir = "asc";   // unstable first → user spots the problem clusters
    const cols = [
      { key: "id",     label: "id",       align: "right", value: r => r.clusterId },
      { key: "count",  label: "count",    align: "right", value: r => r.memberCount },
      { key: "meanJaccard", label: "mean Jaccard", align: "right", value: r => r.meanJaccard },
      { key: "class",  label: "class",    align: "left",  value: r => r.classification },
    ];

    function rebuild() {
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
          if (sortKey === col.key) {
            sortDir = sortDir === "asc" ? "desc" : "asc";
          } else {
            sortKey = col.key;
            sortDir = "asc";
          }
          rebuild();
        });
        trh.appendChild(th);
      }
      thead.appendChild(trh);
      table.appendChild(thead);

      const sorted = br.perCluster.slice().sort((a, b) => {
        const col = cols.find(c => c.key === sortKey);
        const av = col.value(a), bv = col.value(b);
        if (av === bv) return 0;
        return (av < bv ? -1 : 1) * (sortDir === "asc" ? 1 : -1);
      });

      const sel = getState().selection || {};
      const lvl = (getState().clusterLevels || []).length - 1;   // finest; bootstrap is finest-only per §6.18.2
      const isSel = (r) => sel.type === "cluster" && sel.level === lvl && sel.id === r.clusterId;

      const tbody = document.createElement("tbody");
      for (const r of sorted) {
        const tr = document.createElement("tr");
        tr.className = `panel-bs-row class-${r.classification}`;
        if (isSel(r)) tr.classList.add("selected");
        for (const col of cols) {
          const td = document.createElement("td");
          td.style.textAlign = col.align;
          if (col.key === "meanJaccard") {
            td.textContent = fmtScalar(r.meanJaccard);
          } else {
            td.textContent = String(col.value(r));
          }
          tr.appendChild(td);
        }
        tr.addEventListener("click", () => {
          if (isSel(r)) setSelection({ type: null, id: null });
          else          setSelection({ type: "cluster", level: lvl, id: r.clusterId });
        });
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
    }
    rebuild();

    // Save-this-run button (live mode only).
    if (savable) {
      const saveRow = document.createElement("div");
      saveRow.className = "panel-bs-saverow";
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "panel-bs-save";
      saveBtn.textContent = "Save this run";
      saveBtn.title = "Save as a Validation run — survives a project reload and is openable later from the panel picker.";
      saveBtn.addEventListener("click", () => {
        const s = getState();
        const ds   = s.dataSource;
        const mode = (ds && ds.mode) || "toy";
        const cfg  = (ds && ds.configs && ds.configs[mode]) || {};
        const subsetTag = mode === "real" ? (cfg.subset || "real") : `toy n=${s.genResult ? s.genResult.nodes.length : "?"}`;
        const algoTag   = s.layerParams.clustering.method;
        const auto      = `bootstrap ${algoTag} · ${subsetTag} · B=${liveConfig.B}`;
        const label = window.prompt("Label for this bootstrap run:", auto);
        if (label === null) return;

        try {
          const id = saveValidationRun({
            type: "bootstrapStability",
            label: label.trim() || auto,
            inputs: {
              dataSourceId:        mode,
              dataSourceConfig:    cfg,
              layerParamsSnapshot: s.layerParams,
            },
            settings: { ...liveConfig },
            results: {
              bootstrapResult: br,
              aggregate:       br.aggregate,
              cluster:         { label: curSummary.label, nClusters: curSummary.nClusters },
            },
            scoreVersion: SCORE_VERSION,
            runtimeSec,
          });
          saveBtn.textContent = "Saved ✓";
          saveBtn.disabled = true;
          setTimeout(() => { saveBtn.textContent = "Save again"; saveBtn.disabled = false; }, 1500);
          console.log("[bootstrap-stability panel] saved validation run:", id);
        } catch (e) {
          console.error("[bootstrap-stability panel] saveValidationRun failed:", e);
          saveBtn.textContent = "Save failed — see console";
        }
      });
      saveRow.appendChild(saveBtn);
      host.appendChild(saveRow);
    }
  }

  render();
  const unsub = subscribe(() => render());

  return {
    update() { render(); },
    destroy() {
      if (abortController) abortController.abort();
      unsub();
    },
  };
}

// ── helpers ──

function currentClusteringSummary() {
  const s = getState();
  const cfg = s.layerParams && s.layerParams.clustering;
  const lvls = s.clusterLevels || [];
  if (!cfg || lvls.length === 0) return null;
  const algoId = cfg.method;
  let label = algoId;
  try {
    const a = getClusteringAlgo(algoId);
    label = a && a.label ? a.label : algoId;
  } catch (_) {}
  const finest = lvls[lvls.length - 1].clusterResult;
  return {
    label,
    algoId,
    nClusters: finest ? finest.clusters.length : 0,
  };
}

function formatSavedMeta(run) {
  const dt = run.timestamp ? new Date(run.timestamp).toLocaleString() : "";
  const inputsDS  = run.inputs && run.inputs.dataSourceId;
  const inputsCfg = run.inputs && run.inputs.dataSourceConfig;
  const subset = inputsCfg && inputsCfg.subset ? ` · ${inputsCfg.subset}` : "";
  const fixtureTag = inputsDS ? `${inputsDS}${subset}` : "unknown source";
  const settings = run.settings || {};
  const protoTag = `B=${settings.B} · frac=${settings.subsampleFrac} · minMembers=${settings.minMembers} · noise=${settings.noiseHandling}`;
  return `${fixtureTag} · ${protoTag} · saved ${dt}`;
}

function fmtScalar(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(2);
  return v.toFixed(3);
}

function makeSlider(labelText, min, max, step, init, onInput, hint) {
  const row = document.createElement("div");
  row.className = "panel-bs-cfg-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  if (hint) lab.title = hint;
  row.appendChild(lab);
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(init);
  row.appendChild(input);
  const readout = document.createElement("span");
  readout.className = "panel-bs-cfg-readout";
  readout.textContent = String(init);
  row.appendChild(readout);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    readout.textContent = step < 1 ? v.toFixed(2) : String(v);
    onInput(v);
  });
  return row;
}

function makeNumber(labelText, min, max, init, onChange, hint) {
  const row = document.createElement("div");
  row.className = "panel-bs-cfg-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  if (hint) lab.title = hint;
  row.appendChild(lab);
  const inp = document.createElement("input");
  inp.type = "number";
  inp.min = String(min); inp.max = String(max);
  inp.value = String(init);
  inp.style.width = "60px";
  row.appendChild(inp);
  inp.addEventListener("change", () => {
    let v = parseInt(inp.value, 10);
    if (!Number.isFinite(v)) v = init;
    if (v < min) v = min; if (v > max) v = max;
    inp.value = String(v);
    onChange(v);
  });
  return row;
}

function makeSelect(labelText, init, options, onChange, hint) {
  const row = document.createElement("div");
  row.className = "panel-bs-cfg-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  if (hint) lab.title = hint;
  row.appendChild(lab);
  const sel = document.createElement("select");
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = opt.value; o.textContent = opt.label;
    if (opt.value === init) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  row.appendChild(sel);
  return row;
}
