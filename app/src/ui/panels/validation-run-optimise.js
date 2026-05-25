// Panel: render a saved Optimise validation run (§6.19).
//
// Bound to a specific run via `config.runId`. Reads the run from
// state.validationRuns, renders its ranked table with the same
// renderer the in-modal Optimise tab uses. Per-row Apply still
// works — clicks route through the clustering descriptor like the
// live tab, but with no precomputedCr (saved-run rows have _cr
// stripped per §6.19.2 v1; Apply triggers a fresh infer).
//
// If the bound run is deleted (or the project is loaded with no
// matching run), the panel shows a small empty-state hint rather
// than crashing.

import { getState, subscribe }  from "../state.js";
import { enqueueBusy }           from "../busy.js";
import { getLayerDescriptor }    from "../modals/layer-descriptors.js";
import { renderResults }         from "../modals/clustering-tabs/optimise-results-renderer.js";

export const ID          = "validation-run-optimise";
export const LABEL       = "Saved Optimise run";
export const DESCRIPTION = "Renders a saved Optimise sweep table. Per-row Apply lands the chosen config into a clustering level.";
// Hide from the picker's main type list — this panel is only useful
// when bound to a specific runId, which the picker injects via the
// "Validation runs" section instead.
export const HIDE_FROM_TYPE_LIST = true;

export function mount(container, _state, config = {}) {
  container.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "panel-vr-optimise";
  container.appendChild(wrap);

  const runId = config && config.runId;
  let lastRunRef = null;

  function findRun() {
    const runs = getState().validationRuns || [];
    return runs.find(r => r.id === runId) || null;
  }

  function render() {
    const run = findRun();
    if (run === lastRunRef) return;   // no change → skip rerender (avoids row-click churn)
    lastRunRef = run;

    if (!run) {
      wrap.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "panel-vr-empty";
      empty.textContent = "This saved run no longer exists. Open the panel picker (+) to choose another.";
      wrap.appendChild(empty);
      return;
    }

    wrap.innerHTML = "";

    // Header — label, type, when, settings summary.
    const header = document.createElement("div");
    header.className = "panel-vr-header";
    const title = document.createElement("div");
    title.className = "panel-vr-title";
    title.textContent = run.label || "(unlabelled run)";
    header.appendChild(title);
    const meta = document.createElement("div");
    meta.className = "panel-vr-meta";
    const dt = run.timestamp ? new Date(run.timestamp).toLocaleString() : "";
    const inputsDS = run.inputs && run.inputs.dataSourceId;
    const inputsCfg = run.inputs && run.inputs.dataSourceConfig;
    const subset = inputsCfg && inputsCfg.subset ? ` · ${inputsCfg.subset}` : "";
    const fixtureTag = inputsDS ? `${inputsDS}${subset}` : "unknown source";
    meta.textContent = `${run.results.totalConfigs} configs · ranked by ${run.results.scorerLabel || run.results.scorerId} · ${fixtureTag} · saved ${dt}`;
    header.appendChild(meta);

    // Fixture-mismatch warning: the saved run was produced on a
    // particular dataSource; if the current state has a different
    // dataSource, applying a row will re-infer against the CURRENT
    // data (not the saved data), which may not be what the user wants.
    const curMode = getState().dataSource && getState().dataSource.mode;
    if (inputsDS && curMode && inputsDS !== curMode) {
      const warn = document.createElement("div");
      warn.className = "panel-vr-warn";
      warn.textContent = `⚠ Saved on data source "${inputsDS}"; current is "${curMode}". Apply will re-infer against the current data.`;
      header.appendChild(warn);
    }

    wrap.appendChild(header);

    // Body — the ranked table.
    const body = document.createElement("div");
    body.className = "panel-vr-body";
    wrap.appendChild(body);

    // Reconstruct the {ranked, totalConfigs, completed} outcome
    // the renderer expects, plus a scorer descriptor.
    const outcome = {
      ranked:       run.results.ranked || [],
      totalConfigs: run.results.totalConfigs,
      completed:    run.results.completed,
    };
    const scorer = {
      id:    run.results.scorerId,
      label: run.results.scorerLabel || run.results.scorerId,
    };

    // Per-row Apply: same routing as the in-modal tab. We don't have
    // the modal's getLevels helper here, so pass null → renderer
    // falls back to a single "Apply" button per row (lands on L0).
    // _cr is absent in v1-persisted runs → precomputedCr = null.
    const onApplyRow = (row /*, levelIdx */) => {
      const desc = getLayerDescriptor("clustering");
      if (!desc) {
        console.warn("[panel-vr-optimise] no clustering descriptor; can't apply");
        return;
      }
      const active = desc.getActive();
      const newLvl = {
        uid:    Math.random().toString(36).slice(2, 10),
        params: { ...row.params },
        scope:  "global",
      };
      // Replace L0 wholesale (single-level apply). Matches the
      // legacy in-modal behaviour when there's no level picker.
      const levels = [newLvl, ...(active.levels || []).slice(1)];
      // precomputedCr null → recluster re-infers. cr persistence
      // would let this skip; queued under the §6.19 follow-ups.
      enqueueBusy(`Applying ${row.algoLabel || row.algoId}…`,
                  () => desc.applyChange(row.algoId, levels, { precomputedCr: null }))
        .catch(e => console.error("[panel-vr-optimise] apply failed:", e));
    };

    renderResults(body, outcome, scorer, onApplyRow, null);
  }

  render();
  const unsub = subscribe(() => render());

  return {
    update() { render(); },
    destroy() { unsub(); },
  };
}
