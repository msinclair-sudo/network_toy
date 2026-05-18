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

import { getState, update, setOptimiseResult } from "../../state.js";
import * as engine from "../../engine.js";
import { listAlgorithms } from "../../../clustering-registry.js";
import { sweepAcrossAlgorithms } from "../../../eval/sweep.js";
import {
  ariScorer, stabilityScorer,
  numClustersScorer, clusterRichnessScorer,
} from "../../../eval/scorers.js";

export function buildOptimiseTab(host, opts = {}) {
  const onApplyRow = opts.onApplyRow || (() => {});

  const allAlgos = listAlgorithms();
  // Per-algorithm enable flags.
  const enabled = new Map(allAlgos.map(a => [a.id, true]));
  const abortSignal = { aborted: false };

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
  let resolutionOnly = true;

  // Sweep depth toggle — defaults to "resolution only" so the cross-
  // algo grid stays small (otherwise HDBSCAN's full grid alone is
  // hundreds of configs and dominates runtime).
  const depthRow = document.createElement("div");
  depthRow.className = "cm-tab-checkbox-row";
  const depthLabel = document.createElement("label");
  depthLabel.textContent = "Sweep depth";
  depthRow.appendChild(depthLabel);
  const depthBody = document.createElement("div");
  depthBody.className = "cm-tab-checkbox-body";
  for (const opt of [
    { value: "resolution", label: "Resolution only", checked: true },
    { value: "full",       label: "Full grid",       checked: false },
  ]) {
    const lab = document.createElement("label");
    lab.className = "cm-tab-checkbox";
    const r = document.createElement("input");
    r.type = "radio";
    r.name = "sweep-depth";
    r.value = opt.value;
    r.checked = opt.checked;
    r.addEventListener("change", () => {
      if (r.checked) resolutionOnly = (opt.value === "resolution");
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
  depthHint.textContent = "Resolution only: tries different settings for the parameters that control how many clusters you get (e.g. minimum cluster size, k). Faster. Full grid: tries every combination of every parameter the algorithm exposes — much slower but more thorough.";
  depthRow.appendChild(depthHint);
  settings.appendChild(depthRow);

  settings.appendChild(slider("Bootstraps",  5, 30, 1, B, (v) => { B = v; },
    "Bootstrap iterations per config (only used when ranking by reproducibility or richness; ignored for other scorers). Lower for faster sweeps; 10 is a reasonable default."));

  // Scorer dropdown — pluggable metric the sweep ranks by.
  const scorerRow = document.createElement("div");
  scorerRow.className = "cm-tab-select-row";
  const scorerLabel = document.createElement("label");
  scorerLabel.textContent = "Ranked by";
  scorerRow.appendChild(scorerLabel);
  const scorerSelect = document.createElement("select");
  for (const opt of [
    { value: "auto",        label: "Automatic" },
    { value: "ari",         label: "Match to known groups" },
    { value: "richness",    label: "Cluster richness (count × reproducibility)" },
    { value: "numClusters", label: "Number of clusters" },
    { value: "stability",   label: "Cluster reproducibility (Hennig %)" },
  ]) {
    const o = document.createElement("option");
    o.value = opt.value; o.textContent = opt.label;
    if (opt.value === scorerId) o.selected = true;
    scorerSelect.appendChild(o);
  }
  scorerSelect.addEventListener("change", () => { scorerId = scorerSelect.value; });
  scorerRow.appendChild(scorerSelect);
  const scorerHint = document.createElement("div");
  scorerHint.className = "cm-tab-slider-hint cm-tab-select-hint";
  scorerHint.textContent =
    "Automatic picks the most appropriate metric for whatever data is loaded. " +
    "Match to known groups compares your clustering against ground-truth labels — only works when those labels exist (e.g. the toy generator's origins). " +
    "Cluster richness multiplies cluster count by how reproducible each cluster is under resampling — balanced metric, recommended for real data. " +
    "Number of clusters ranks purely by how many groups the algorithm produced (informative when you trust the algorithm and want to push toward more clusters; doesn't filter out noise-fragmentation). " +
    "Cluster reproducibility re-clusters resampled data and asks what fraction of clusters reappear — beware it rewards trivially-coarse partitions.";
  scorerRow.appendChild(scorerHint);
  settings.appendChild(scorerRow);

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

  // Restore from state if a previous sweep is cached. The scorer used
  // for that run is recorded with it so we render headers correctly.
  const cachedOpt = getState().evalResults && getState().evalResults.optimise;
  if (cachedOpt && cachedOpt.ranked) {
    renderResults(
      results,
      { ranked: cachedOpt.ranked, totalConfigs: cachedOpt.totalConfigs, completed: cachedOpt.completed },
      { id: cachedOpt.scorerId, label: cachedOpt.scorerLabel },
      onApplyRow,
    );
    results.style.display = "";
    status.textContent = `cached · ${cachedOpt.totalConfigs} configs · ranked by ${cachedOpt.scorerLabel}`;
  }

  runBtn.addEventListener("click", async () => {
    const s = getState();
    if (!s.genResult || !s.dimredResult) {
      status.textContent = "Apply a clustering first.";
      return;
    }
    const algos = allAlgos.filter(a => enabled.get(a.id));
    if (algos.length === 0) { status.textContent = "Pick at least one algorithm."; return; }

    const scorer = pickScorer(scorerId, s, B);
    if (!scorer) { status.textContent = "ARI requires toy mode (no ground truth in real data)."; return; }

    abortSignal.aborted = false;
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
      outcome = await sweepAcrossAlgorithms({
        algorithms:    algos,
        genResult:     s.genResult,
        dimredResult:  s.dimredResult,
        scorer,
        resolutionOnly,
        onProgress: (i, total, label) => { status.textContent = `${i} / ${total} · ${label}`; },
        abortSignal,
      });
    } catch (e) {
      console.error("[optimise-tab] sweep threw:", e);
      status.textContent = "error — see console";
    }

    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    if (outcome) {
      // Cache into state so the table survives tab hops + project saves.
      setOptimiseResult({
        ranked:       outcome.ranked,
        totalConfigs: outcome.totalConfigs,
        completed:    outcome.completed,
        scorerId:     scorer.id,
        scorerLabel:  scorer.label,
        settings:     { B, scorerId, resolutionOnly, algorithms: algos.map(a => a.id) },
        runtimeSec:   parseFloat(dt),
        timestamp:    new Date().toISOString(),
      });
      renderResults(results, outcome, scorer, onApplyRow);
      results.style.display = "";
      status.textContent = abortSignal.aborted
        ? `cancelled · ${outcome.completed} / ${outcome.totalConfigs} configs · ${dt}s`
        : `${outcome.totalConfigs} configs in ${dt}s · ranked by ${scorer.label}`;
    }

    runBtn.disabled = false;
    runBtn.textContent = "Run sweep";
    runBtn.classList.remove("running");
    cancelBtn.style.display = "none";
  });

  cancelBtn.addEventListener("click", () => {
    abortSignal.aborted = true;
  });

  return {
    onTabHidden() { abortSignal.aborted = true; },
  };
}

// Pick the active scorer based on user choice + data-source mode.
// Returns null when the chosen scorer is unsupported (e.g. ARI under
// real mode where there's no ground truth).
function pickScorer(scorerId, state, B) {
  const isReal = state.dataSource && state.dataSource.mode === "real";
  if (scorerId === "auto") {
    // Toy → ARI (ground truth available). Real → cluster richness
    // (balanced metric — count × reproducibility — chosen as default
    // after the stability-alone scorer over-rewarded trivial coarse
    // partitions).
    return isReal ? clusterRichnessScorer({ B }) : ariScorer(extractGroundTruth(state));
  }
  if (scorerId === "richness")    return clusterRichnessScorer({ B });
  if (scorerId === "numClusters") return numClustersScorer();
  if (scorerId === "stability")   return stabilityScorer({ B });
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

// Render the full ranked list of configs (not just top-N) with
// sortable columns. Columns shown depend on which scorer ran:
//   - always: rank, algorithm, params, clusters, apply
//   - ARI:     + match (ARI score)
//   - richness:    + reproducibility (meanJaccard), richness
//   - stability:   + stable %, reproducibility (meanJaccard)
//   - numClusters: (no extra column — primary already shown as clusters)
//
// The `#` column reflects the ORIGINAL primary-ranked position and
// stays fixed when the user sorts by other columns — it's the "what
// did the chosen scorer think?" anchor.
function renderResults(host, outcome, scorer, onApplyRow) {
  host.innerHTML = "";
  const head = document.createElement("h4");
  head.className = "cm-tab-section-title";
  head.textContent = "Results";
  host.appendChild(head);

  // Tag rows with their primary-rank position; never re-numbered on sort.
  const rows = outcome.ranked.map((r, idx) => ({ ...r, primaryRank: idx + 1 }));

  // Build column definitions per scorer. Each column declares:
  //   key      — used for sort + cell lookup
  //   label    — header text
  //   align    — left / right
  //   sortable — clickable header
  //   value(r) — extracts the sortable value from a row
  //   render(r)— returns HTML/string for the cell
  const baseCols = [
    {
      key: "rank", label: "#", align: "right", sortable: true,
      value: r => r.primaryRank,
      render: r => String(r.primaryRank),
    },
    {
      key: "algo", label: "Algorithm", align: "left", sortable: true,
      value: r => r.algoLabel,
      render: r => r.algoLabel,
    },
    {
      key: "params", label: "Params", align: "left", sortable: false,
      value: r => 0,
      render: r => `<code class="cm-tab-params">${formatParams(r.params)}</code>`,
    },
    {
      key: "clusters", label: "Clusters", align: "right", sortable: true,
      value: r => r.numClusters,
      render: r => String(r.numClusters),
    },
  ];

  const scorerCols = scorerSpecificCols(scorer);
  const applyCol = {
    key: "apply", label: "", align: "right", sortable: false,
    value: r => 0,
    render: () => `<button type="button" class="cm-tab-apply">Apply</button>`,
  };
  const cols = [...baseCols, ...scorerCols, applyCol];

  // Default sort = primary scorer's value (= rank ascending).
  let sortKey = "rank";
  let sortDir = "asc";

  const table = document.createElement("table");
  table.className = "cm-tab-table cm-tab-table-wide cm-tab-table-sortable";
  host.appendChild(table);

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
            // Numeric columns default to descending (biggest first).
            const sample = col.value(rows[0]);
            sortDir = typeof sample === "number" ? "desc" : "asc";
          }
          rebuild();
        });
      }
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);

    const sortedRows = rows.slice().sort((a, b) => {
      const col = cols.find(c => c.key === sortKey);
      if (!col) return 0;
      const av = col.value(a), bv = col.value(b);
      if (av === bv) return 0;
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      return sortDir === "asc" ? 1 : -1;
    });

    const tbody = document.createElement("tbody");
    for (const r of sortedRows) {
      const tr = document.createElement("tr");
      tr.className = "cm-tab-row";
      for (const col of cols) {
        const td = document.createElement("td");
        td.style.textAlign = col.align;
        td.innerHTML = col.render(r);
        tr.appendChild(td);
      }
      tr.querySelector(".cm-tab-apply").addEventListener("click", () => onApplyRow(r));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  rebuild();
}

// Columns specific to the active scorer.
function scorerSpecificCols(scorer) {
  if (scorer.id === "ari") {
    return [{
      key: "match", label: "Match", align: "right", sortable: true,
      value: r => Number.isFinite(r.primary) ? r.primary : -Infinity,
      render: r => formatScalar(r.primary),
    }];
  }
  if (scorer.id === "richness") {
    return [
      {
        key: "meanJ", label: "Reproducibility", align: "right", sortable: true,
        value: r => Number.isFinite(r.secondary) ? r.secondary : -Infinity,
        render: r => formatScalar(r.secondary),
      },
      {
        key: "richness", label: "Richness", align: "right", sortable: true,
        value: r => Number.isFinite(r.primary) ? r.primary : -Infinity,
        render: r => formatScalar(r.primary),
      },
    ];
  }
  if (scorer.id === "stability") {
    return [
      {
        key: "stable", label: "Stable %", align: "right", sortable: true,
        value: r => Number.isFinite(r.primary) ? r.primary : -Infinity,
        render: r => formatPct(r.primary),
      },
      {
        key: "meanJ", label: "Reproducibility", align: "right", sortable: true,
        value: r => Number.isFinite(r.secondary) ? r.secondary : -Infinity,
        render: r => formatScalar(r.secondary),
      },
    ];
  }
  // numClusters scorer: clusters column already shows the primary.
  return [];
}

function formatScalar(v) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 10)  return v.toFixed(2);
  return v.toFixed(3);
}
function formatPct(v) {
  if (!Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(0)}%`;
}
function formatParams(p) {
  return Object.entries(p).map(([k, v]) => `${k}=${formatVal(v)}`).join(" ");
}
function formatVal(v) {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
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
