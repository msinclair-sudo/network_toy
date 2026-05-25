// Panel: dim-sweep (live or saved).
//
// Two modes selected by `config.runId`:
//   - **Live** (no runId): user picks dims / seeds / algos + params,
//     clicks Run; the panel calls runDimSweep against the current
//     state.embedding (or basePos at toy scale); results render
//     in-place (heatmap + cluster-count bars + verdict banner); a
//     Save-this-run button archives as a `type: "dimSweep"`
//     ValidationRun.
//   - **Saved** (runId set): read-only render of the matching
//     state.validationRuns entry. No Run / Save buttons. Verdict
//     pair + threshold are pinned to what the saved run was
//     evaluated against.
//
// Promotes §6.9's validation/dim_sweep_validation.py to an in-app
// surface so the empirical check travels with the project (saved as
// a ValidationRun, survives reload, openable from the panel picker).

import {
  getState, subscribe, saveValidationRun,
} from "../state.js";
import { listAlgorithms as listDimredAlgos, getAlgorithm as getDimredAlgo } from "../../dimred/registry.js";
import { listAlgorithms as listClusteringAlgos, getAlgorithm as getClusteringAlgo } from "../../clustering-registry.js";
import { runDimSweep, dimSweepVerdict, estimateDimSweepCost } from "../../eval/dim-sweep.js";
import { renderHeatmap } from "../charts/heatmap.js";
import { renderBars }    from "../charts/bars.js";

export const ID          = "dim-sweep";
export const LABEL       = "Dim sweep";
export const DESCRIPTION = "ARI dim-sweep validation (§6.9). Sweeps the compression stage across target dims × seeds, computes pairwise ARI between same-seed partitions, surfaces a verdict against a user-chosen threshold. Heatmap + cluster-count bars + Save-this-run.";
export const SINGLETON   = true;

const DEFAULT_DIMS  = [30, 50, 100, 200];
const DEFAULT_SEEDS = [42, 43, 44];
const DEFAULT_THRESHOLD = 0.9;

export function mount(container, _state, config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-ds";
  container.appendChild(wrap);

  const runId    = (config && config.runId) || null;
  const liveMode = !runId;

  // Live-mode editable state. Initialised to the validation-script
  // protocol defaults so the user lands on a known-good config.
  const liveConfig = {
    dimsText:  DEFAULT_DIMS.join(", "),
    seedsText: DEFAULT_SEEDS.join(", "),
    noise:       cloneAlgoConfig("pca",      "noise"),
    compression: cloneAlgoConfig("umap",     "compression"),
    clustering:  cloneClusteringConfig("hdbscan"),
    verdictPair:      [50, 100],
    verdictThreshold: DEFAULT_THRESHOLD,
  };
  let liveResult     = null;        // { result, runtimeSec, ranAt }
  let abortController = null;
  let isRunning      = false;
  let lastSavedRunRef = undefined;  // sentinel — see bootstrap-stability for why undefined not null

  function render() {
    if (!liveMode) {
      const r = findSavedRun();
      if (r === lastSavedRunRef) return;
      lastSavedRunRef = r;
    }

    wrap.innerHTML = "";

    const header = document.createElement("div");
    header.className = "panel-ds-header";
    const title = document.createElement("div");
    title.className = "panel-ds-title";
    const sub   = document.createElement("div");
    sub.className = "panel-ds-meta";
    header.appendChild(title);
    header.appendChild(sub);
    wrap.appendChild(header);

    if (liveMode) {
      title.textContent = "Dim sweep — live";
      renderLiveBody();
    } else {
      const run = findSavedRun();
      if (!run) {
        title.textContent = "Dim sweep — saved";
        const empty = document.createElement("div");
        empty.className = "panel-ds-empty";
        empty.textContent = "This saved run no longer exists. Open the panel picker (+) to choose another.";
        wrap.appendChild(empty);
        return;
      }
      title.textContent = run.label || "(unlabelled dim-sweep run)";
      sub.textContent = formatSavedMeta(run);
      renderSavedBody(run);
    }
  }

  function findSavedRun() {
    if (liveMode) return null;
    const runs = getState().validationRuns || [];
    return runs.find(r => r.id === runId) || null;
  }

  // ── LIVE MODE ─────────────────────────────────────────────────────
  function renderLiveBody() {
    const s = getState();
    const n = s.genResult ? s.genResult.nodes.length : 0;

    if (!s.genResult || (!s.embedding && !s._basePos)) {
      const empty = document.createElement("div");
      empty.className = "panel-ds-empty";
      empty.textContent = "Load a dataset first (workflow chart → Data → choose toy or real). Dim-sweep needs an embedding (real mode) or basePos (toy) to feed the noise stage.";
      wrap.appendChild(empty);
      return;
    }

    // ── Config section.
    const cfgWrap = document.createElement("div");
    cfgWrap.className = "panel-ds-cfg";
    wrap.appendChild(cfgWrap);

    // Sweep axes.
    cfgWrap.appendChild(buildSectionTitle("Sweep axes"));
    cfgWrap.appendChild(buildTextRow(
      "Dims to sweep", liveConfig.dimsText,
      "Comma-separated target dims for the compression stage's n_components. Validation default: 30, 50, 100, 200.",
      (v) => { liveConfig.dimsText = v; updateEstimateBanner(); }
    ));
    cfgWrap.appendChild(buildTextRow(
      "Seeds", liveConfig.seedsText,
      "Comma-separated seeds for the compression stage's random_state. Validation default: 42, 43, 44 (3 seeds × 4 dims = 12 runs).",
      (v) => { liveConfig.seedsText = v; updateEstimateBanner(); }
    ));

    // Noise.
    cfgWrap.appendChild(buildSectionTitle("Noise stage"));
    cfgWrap.appendChild(buildAlgoSection(
      "noise", liveConfig.noise,
      listDimredAlgos("noise"),
      [],   // no swept keys to hide
    ));

    // Compression. n_components and random_state are swept — hide from the UI.
    cfgWrap.appendChild(buildSectionTitle("Compression stage (swept axis)"));
    cfgWrap.appendChild(buildAlgoSection(
      "compression", liveConfig.compression,
      listDimredAlgos("compression"),
      ["n_components", "random_state"],
    ));

    // Clustering.
    cfgWrap.appendChild(buildSectionTitle("Clustering"));
    cfgWrap.appendChild(buildAlgoSection(
      "clustering", liveConfig.clustering,
      listClusteringAlgos(),
      [],
    ));

    // Estimate banner.
    const estimateBox = document.createElement("div");
    estimateBox.className = "panel-ds-estimate";
    wrap.appendChild(estimateBox);
    function updateEstimateBanner() {
      const dims  = parseIntList(liveConfig.dimsText);
      const seeds = parseIntList(liveConfig.seedsText);
      if (dims.length < 2 || seeds.length < 1) {
        estimateBox.textContent = "Enter at least 2 dims and 1 seed.";
        estimateBox.dataset.warn = "true";
        return;
      }
      delete estimateBox.dataset.warn;
      const sec = estimateDimSweepCost({ n, dims, seeds });
      estimateBox.textContent = `${dims.length * seeds.length} runs (${dims.length} dims × ${seeds.length} seeds) at n=${n} · estimated ${formatDuration(sec)} wall time.`;
    }
    updateEstimateBanner();

    // Run / Cancel row.
    const runRow = document.createElement("div");
    runRow.className = "panel-ds-runrow";
    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "panel-ds-run";
    runBtn.textContent = isRunning ? "Running…" : "Run sweep";
    runBtn.disabled = isRunning;
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "panel-ds-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.style.display = isRunning ? "" : "none";
    const status = document.createElement("span");
    status.className = "panel-ds-status";
    runRow.appendChild(runBtn);
    runRow.appendChild(cancelBtn);
    runRow.appendChild(status);
    wrap.appendChild(runRow);

    runBtn.addEventListener("click", async () => {
      const dims  = parseIntList(liveConfig.dimsText);
      const seeds = parseIntList(liveConfig.seedsText);
      if (dims.length < 2 || seeds.length < 1) {
        status.textContent = "need ≥ 2 dims and ≥ 1 seed";
        return;
      }
      const sec = estimateDimSweepCost({ n, dims, seeds });
      const msg = `Run ${dims.length * seeds.length} (dim × seed) iterations at n=${n}?\n` +
                  `Estimated wall time: ${formatDuration(sec)}.\n\n` +
                  `Each iter is a UMAP fit + HDBSCAN inference. You can Cancel mid-flight.`;
      if (!window.confirm(msg)) return;

      abortController = new AbortController();
      isRunning = true;
      runBtn.disabled = true;
      runBtn.textContent = "Running…";
      cancelBtn.style.display = "";
      status.textContent = "noise…";

      const input = pickStage0Input(getState());
      if (!input) {
        status.textContent = "no embedding / basePos to feed the sweep";
        isRunning = false; runBtn.disabled = false; runBtn.textContent = "Run sweep";
        cancelBtn.style.display = "none";
        return;
      }

      const t0 = performance.now();
      try {
        const result = await runDimSweep({
          input,
          genResult:    getState().genResult,
          dims,
          seeds,
          noise:        { method: liveConfig.noise.method,       params: liveConfig.noise.params },
          compression:  { method: liveConfig.compression.method, params: liveConfig.compression.params },
          clustering:   { method: liveConfig.clustering.method,  params: liveConfig.clustering.params },
          abortSignal:  abortController.signal,
          onProgress:   (stage, done, total) => {
            status.textContent = (typeof done === "number" && typeof total === "number")
              ? `${done} / ${total} · ${stage}`
              : stage;
          },
        });
        const dt = (performance.now() - t0) / 1000;
        liveResult = { result, runtimeSec: dt, ranAt: new Date().toISOString() };

        // Default verdict pair: prefer (50, 100) if present, else the
        // last two swept dims (the "is the lower-dim throwing away
        // information vs the highest swept dim" question).
        if (dims.includes(50) && dims.includes(100)) {
          liveConfig.verdictPair = [50, 100];
        } else {
          liveConfig.verdictPair = [dims[dims.length - 2], dims[dims.length - 1]];
        }

        status.textContent = `done · ${formatDuration(dt)}`;
      } catch (e) {
        if (e && e.name === "AbortError") {
          status.textContent = "cancelled";
        } else {
          console.error("[dim-sweep panel] runDimSweep failed:", e);
          status.textContent = `error: ${e.message || e}`;
        }
      }
      isRunning = false;
      runBtn.disabled = false;
      runBtn.textContent = "Run sweep";
      cancelBtn.style.display = "none";
      renderResultsArea(/*savable=*/ true);
    });
    cancelBtn.addEventListener("click", () => {
      if (abortController) abortController.abort();
    });

    // Results area.
    const results = document.createElement("div");
    results.className = "panel-ds-results";
    wrap.appendChild(results);
    renderResultsArea(/*savable=*/ true);

    function renderResultsArea(savable) {
      results.innerHTML = "";
      if (!liveResult) return;
      renderResultBody(results, liveResult.result, liveConfig.verdictPair,
                       liveConfig.verdictThreshold, savable, liveResult.runtimeSec);
    }
  }

  // ── SAVED MODE ────────────────────────────────────────────────────
  function renderSavedBody(run) {
    const body = document.createElement("div");
    body.className = "panel-ds-results";
    wrap.appendChild(body);

    const result    = run.results && run.results.sweep;
    const pair      = (run.settings && run.settings.verdictPair) || [run.results.sweep.dims[run.results.sweep.dims.length - 2], run.results.sweep.dims[run.results.sweep.dims.length - 1]];
    const threshold = (run.settings && run.settings.verdictThreshold) ?? DEFAULT_THRESHOLD;
    if (!result) {
      const empty = document.createElement("div");
      empty.className = "panel-ds-empty";
      empty.textContent = "(saved run carries no sweep result — likely a schema mismatch)";
      body.appendChild(empty);
      return;
    }
    renderResultBody(body, result, pair, threshold, /*savable=*/ false, run.runtimeSec);
  }

  // ── shared results renderer ───────────────────────────────────────
  function renderResultBody(host, sweep, pair, threshold, savable, runtimeSec) {
    const { dims, seeds, ariMatrix, clusterCounts } = sweep;
    const verdict = dimSweepVerdict(sweep, pair[0], pair[1], threshold);

    // Verdict pair picker (live mode only; saved mode shows the picker
    // values read-only to keep the surface consistent).
    const verdictRow = document.createElement("div");
    verdictRow.className = "panel-ds-verdict-row";

    const pickerLabel = document.createElement("span");
    pickerLabel.className = "panel-ds-verdict-pickerlabel";
    pickerLabel.textContent = "Verdict pair:";
    verdictRow.appendChild(pickerLabel);

    const d1Sel = document.createElement("select");
    const d2Sel = document.createElement("select");
    for (const d of dims) {
      const o1 = document.createElement("option");
      o1.value = String(d); o1.textContent = String(d);
      if (d === pair[0]) o1.selected = true;
      d1Sel.appendChild(o1);
      const o2 = document.createElement("option");
      o2.value = String(d); o2.textContent = String(d);
      if (d === pair[1]) o2.selected = true;
      d2Sel.appendChild(o2);
    }
    d1Sel.disabled = !savable;
    d2Sel.disabled = !savable;
    verdictRow.appendChild(d1Sel);
    const sep = document.createElement("span");
    sep.textContent = "vs";
    sep.style.opacity = "0.6";
    verdictRow.appendChild(sep);
    verdictRow.appendChild(d2Sel);

    const thLabel = document.createElement("span");
    thLabel.className = "panel-ds-verdict-thlabel";
    thLabel.textContent = "threshold";
    verdictRow.appendChild(thLabel);
    const thInput = document.createElement("input");
    thInput.type = "number";
    thInput.min = "0"; thInput.max = "1"; thInput.step = "0.05";
    thInput.value = String(threshold);
    thInput.style.width = "62px";
    thInput.disabled = !savable;
    verdictRow.appendChild(thInput);

    host.appendChild(verdictRow);

    const rerender = () => {
      if (!savable) return;
      const d1 = parseInt(d1Sel.value, 10);
      const d2 = parseInt(d2Sel.value, 10);
      const th = parseFloat(thInput.value);
      liveConfig.verdictPair = [d1, d2];
      liveConfig.verdictThreshold = Number.isFinite(th) ? th : DEFAULT_THRESHOLD;
      renderResultBody(host, sweep,
                       liveConfig.verdictPair, liveConfig.verdictThreshold,
                       savable, runtimeSec);
    };
    d1Sel.addEventListener("change", rerender);
    d2Sel.addEventListener("change", rerender);
    thInput.addEventListener("change", rerender);

    // Wipe everything after the picker and rebuild — easier than
    // surgically updating individual chart hosts.
    // (We just appended verdictRow; remove subsequent children before
    // re-adding banner / charts.)
    while (host.children.length > 1) host.removeChild(host.lastChild);

    // Verdict banner.
    const banner = document.createElement("div");
    banner.className = "panel-ds-verdict-banner";
    banner.dataset.defensible = String(verdict.defensible);
    if (verdict.mean === null) {
      banner.textContent = `ARI(${pair[0]}, ${pair[1]}) — no data`;
    } else {
      const pct = (verdict.mean * 100).toFixed(1);
      const tag = verdict.defensible ? "PASS" : "FAIL";
      banner.innerHTML =
        `<b>${tag}</b> · mean ARI(${pair[0]}, ${pair[1]}) = <b>${verdict.mean.toFixed(3)}</b>` +
        ` ± ${verdict.sd.toFixed(3)}` +
        ` · threshold ${threshold.toFixed(2)}` +
        ` · ${verdict.defensible
              ? `${pair[0]}-d preserves partition structure at this threshold`
              : `${pair[0]}-d differs meaningfully from ${pair[1]}-d — consider bumping the compression default`}`;
    }
    host.appendChild(banner);

    // ARI heatmap.
    const heatmapTitle = document.createElement("div");
    heatmapTitle.className = "panel-ds-chart-title";
    heatmapTitle.textContent = "Mean pairwise ARI across seeds";
    host.appendChild(heatmapTitle);

    const heatmapHost = document.createElement("div");
    heatmapHost.className = "panel-ds-chart-host";
    host.appendChild(heatmapHost);
    const matrix = dims.map(d1 => dims.map(d2 => ariMatrix[d1][d2].mean));
    renderHeatmap(heatmapHost, {
      matrix,
      rowLabels:   dims.map(d => `d=${d}`),
      colLabels:   dims.map(d => `d=${d}`),
      palette:     "ari",
      vmin:        0,
      vmax:        1,
      cellSize:    52,
      legendLabel: "ARI",
      formatCell:  (v) => v.toFixed(3),
      cellTitle:   (rL, cL, v) => {
        const d1n = parseInt(String(rL).replace("d=", ""), 10);
        const d2n = parseInt(String(cL).replace("d=", ""), 10);
        const cell = ariMatrix[d1n] && ariMatrix[d1n][d2n];
        return cell
          ? `ARI(${d1n}, ${d2n}) = ${cell.mean.toFixed(3)} ± ${cell.sd.toFixed(3)} · per seed: ${cell.perSeed.map(x => x.toFixed(3)).join(", ")}`
          : "—";
      },
    });

    // Cluster-count bars.
    const barsTitle = document.createElement("div");
    barsTitle.className = "panel-ds-chart-title";
    barsTitle.textContent = "Cluster counts (mean ± SD across seeds)";
    host.appendChild(barsTitle);

    const barsHost = document.createElement("div");
    barsHost.className = "panel-ds-chart-host";
    host.appendChild(barsHost);
    renderBars(barsHost, {
      values: dims.map(d => clusterCounts[d].mean),
      errors: dims.map(d => clusterCounts[d].sd),
      labels: dims.map(d => `d=${d}`),
      cellSize: 64,
      chartH: 140,
      yLabel: "n clusters",
      formatBar: (v) => v.toFixed(1),
    });

    // Save-this-run button.
    if (savable) {
      const saveRow = document.createElement("div");
      saveRow.className = "panel-ds-saverow";
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "panel-ds-save";
      saveBtn.textContent = "Save this run";
      saveBtn.title = "Save as a Validation run — survives a project reload and is openable later from the panel picker.";
      saveBtn.addEventListener("click", () => {
        const s = getState();
        const ds   = s.dataSource;
        const mode = (ds && ds.mode) || "toy";
        const cfg  = (ds && ds.configs && ds.configs[mode]) || {};
        const subsetTag = mode === "real" ? (cfg.subset || "real") : `toy n=${s.genResult ? s.genResult.nodes.length : "?"}`;
        const dimsList = sweep.dims.join("/");
        const auto = `dimsweep ${liveConfig.compression.method}-{${dimsList}} ${liveConfig.clustering.method} · ${subsetTag}`;
        const label = window.prompt("Label for this dim-sweep run:", auto);
        if (label === null) return;

        try {
          const id = saveValidationRun({
            type: "dimSweep",
            label: label.trim() || auto,
            inputs: {
              dataSourceId:        mode,
              dataSourceConfig:    cfg,
              layerParamsSnapshot: s.layerParams,
            },
            settings: {
              dims:             sweep.dims,
              seeds:            sweep.seeds,
              noise:            liveConfig.noise,
              compression:      liveConfig.compression,
              clustering:       liveConfig.clustering,
              verdictPair:      liveConfig.verdictPair.slice(),
              verdictThreshold: liveConfig.verdictThreshold,
            },
            results: {
              sweep,
              verdict,
            },
            scoreVersion: 1,    // first version of the dimSweep result shape
            runtimeSec,
          });
          saveBtn.textContent = "Saved ✓";
          saveBtn.disabled = true;
          setTimeout(() => { saveBtn.textContent = "Save again"; saveBtn.disabled = false; }, 1500);
          console.log("[dim-sweep panel] saved validation run:", id);
        } catch (e) {
          console.error("[dim-sweep panel] saveValidationRun failed:", e);
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

function cloneAlgoConfig(algoId, slot) {
  const a = getDimredAlgo(algoId);
  if (!a) return { method: algoId, params: {} };
  const params = a.defaultParamsForSlot ? a.defaultParamsForSlot(slot) : (a.defaultParams ? a.defaultParams() : {});
  return { method: algoId, params: { ...params } };
}

function cloneClusteringConfig(algoId) {
  const a = getClusteringAlgo(algoId);
  if (!a) return { method: algoId, params: {} };
  const params = a.defaultParams ? a.defaultParams() : {};
  // The validation script learned that HDBSCAN's locked default
  // (min_cluster_size=100, tuned for 810k papers) degenerates to
  // 2-cluster partitions at n=5000 and mechanically gives ARI ≈ 1
  // across dims. Drop to 15 / 5 for a meaningful signal at sub-10k
  // sizes. User can adjust in the schema rows.
  if (algoId === "hdbscan") {
    return {
      method: algoId,
      params: { ...params, minClusterSize: 15, minSamples: 5 },
    };
  }
  return { method: algoId, params: { ...params } };
}

function pickStage0Input(s) {
  if (!s.genResult) return null;
  const n = s.genResult.nodes.length;
  if (s.embedding && s.embedding.data instanceof Float32Array) {
    return { n, d: s.embedding.d, data: s.embedding.data };
  }
  if (s._basePos instanceof Float32Array) {
    return { n, d: 3, data: s._basePos };
  }
  return null;
}

function parseIntList(text) {
  if (!text) return [];
  return text.split(",")
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => parseInt(s, 10))
    .filter(v => Number.isFinite(v) && v > 0);
}

function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${sec.toFixed(0)} s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

function formatSavedMeta(run) {
  const dt = run.timestamp ? new Date(run.timestamp).toLocaleString() : "";
  const inputsDS  = run.inputs && run.inputs.dataSourceId;
  const inputsCfg = run.inputs && run.inputs.dataSourceConfig;
  const subset = inputsCfg && inputsCfg.subset ? ` · ${inputsCfg.subset}` : "";
  const fixtureTag = inputsDS ? `${inputsDS}${subset}` : "unknown source";
  const dims = (run.settings && run.settings.dims) || [];
  const seeds = (run.settings && run.settings.seeds) || [];
  return `${dims.length} dims × ${seeds.length} seeds · ${fixtureTag} · saved ${dt}`;
}

function buildSectionTitle(text) {
  const h = document.createElement("div");
  h.className = "panel-ds-section";
  h.textContent = text;
  return h;
}

function buildTextRow(labelText, init, hint, onInput) {
  const row = document.createElement("div");
  row.className = "panel-ds-cfg-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  if (hint) lab.title = hint;
  row.appendChild(lab);
  const input = document.createElement("input");
  input.type = "text";
  input.value = init;
  input.className = "panel-ds-cfg-text";
  input.addEventListener("input", () => onInput(input.value));
  row.appendChild(input);
  return row;
}

// Builds an algorithm dropdown + dynamically-rendered params from the
// algorithm's modalSchema. Keys listed in `skipKeys` are omitted (used
// to hide `n_components` and `random_state` on the compression slot
// since they're driven by the sweep axis).
function buildAlgoSection(slotName, cfgRef, algoList, skipKeys) {
  const section = document.createElement("div");
  section.className = "panel-ds-algo-section";

  // Algorithm dropdown.
  const dropRow = document.createElement("div");
  dropRow.className = "panel-ds-cfg-row";
  const lab = document.createElement("label");
  lab.textContent = "Algorithm";
  dropRow.appendChild(lab);
  const sel = document.createElement("select");
  for (const a of algoList) {
    const o = document.createElement("option");
    o.value = a.id; o.textContent = a.label || a.id;
    if (cfgRef.method === a.id) o.selected = true;
    sel.appendChild(o);
  }
  dropRow.appendChild(sel);
  section.appendChild(dropRow);

  const paramsHost = document.createElement("div");
  paramsHost.className = "panel-ds-algo-params";
  section.appendChild(paramsHost);

  function renderParams() {
    paramsHost.innerHTML = "";
    const algo = algoList.find(a => a.id === cfgRef.method) ||
                 algoList[0];
    if (!algo) return;
    const schema = algo.modalSchema || [];
    for (const field of schema) {
      if (skipKeys.includes(field.key)) continue;
      paramsHost.appendChild(renderSchemaField(field, cfgRef.params));
    }
    if (paramsHost.children.length === 0) {
      const none = document.createElement("div");
      none.className = "panel-ds-cfg-hint";
      none.textContent = skipKeys.length > 0 && schema.length > 0
        ? "(remaining params are driven by the sweep axis)"
        : "(no parameters)";
      paramsHost.appendChild(none);
    }
  }
  sel.addEventListener("change", () => {
    cfgRef.method = sel.value;
    // Reset params to the new algorithm's defaults. For dimred, prefer
    // the slot-aware defaults when available.
    let algo;
    if (slotName === "noise" || slotName === "compression") {
      algo = getDimredAlgo(cfgRef.method);
      cfgRef.params = algo && algo.defaultParamsForSlot
        ? { ...algo.defaultParamsForSlot(slotName) }
        : { ...(algo && algo.defaultParams ? algo.defaultParams() : {}) };
    } else {
      algo = getClusteringAlgo(cfgRef.method);
      cfgRef.params = { ...(algo && algo.defaultParams ? algo.defaultParams() : {}) };
    }
    renderParams();
  });
  renderParams();
  return section;
}

// Render one schema field. Mirrors the renderField / buildInput logic in
// dimred-modal.js + algorithm-modal.js. Inlined rather than imported
// because those module-private helpers aren't exported; the third copy
// would be the moment to extract a schema-form module (deferred).
function renderSchemaField(field, params) {
  const row = document.createElement("div");
  row.className = "panel-ds-cfg-row";
  const lab = document.createElement("label");
  lab.textContent = field.label || field.key;
  if (field.hint) lab.title = field.hint;
  row.appendChild(lab);

  let readout = null;
  const input = buildSchemaInput(field, params, () => {
    if (readout) readout.textContent = formatSchemaValue(field, params[field.key]);
  });
  row.appendChild(input);

  if (field.kind === "range" || field.kind === "int") {
    readout = document.createElement("span");
    readout.className = "panel-ds-cfg-readout";
    readout.textContent = formatSchemaValue(field, params[field.key]);
    row.appendChild(readout);
  }
  return row;
}

function buildSchemaInput(field, params, onChange) {
  const cur = params[field.key];
  if (field.kind === "select") {
    const sel = document.createElement("select");
    for (const opt of (field.options || [])) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (cur === opt.value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      params[field.key] = sel.value;
      onChange();
    });
    return sel;
  }
  const input = document.createElement("input");
  input.type  = "range";
  input.min   = String(field.min  ?? 0);
  input.max   = String(field.max  ?? 100);
  input.step  = String(field.step ?? 1);
  input.value = String(cur ?? field.min ?? 0);
  input.addEventListener("input", () => {
    const v = field.kind === "int" ? parseInt(input.value, 10) : parseFloat(input.value);
    params[field.key] = v;
    onChange();
  });
  return input;
}

function formatSchemaValue(field, value) {
  if (field.format) {
    try { return field.format(value); }
    catch (_) { /* fall through */ }
  }
  if (field.kind === "int") return String(value);
  const n = +value;
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10)  return n.toFixed(1);
  return n.toFixed(2);
}
