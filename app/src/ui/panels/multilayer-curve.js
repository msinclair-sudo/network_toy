// Panel: multi-layer LAYER PICKER (§9 producer/picker split, 2026-06-01).
//
// Interactive reproducibility curve. One point per candidate granularity the
// sweep tried — reproducibility (bootstrap-Jaccard) vs. cluster count, with
// the reproducibility floor drawn as a guide line. The user CLICKS points to
// toggle which granularities become coarse→fine layers, then hits Apply to
// commit them into clusterLevels[] (engine.commitMultiLevelLayers, via the
// picker descriptor — no sweep re-run).
//
// Reads the producer card's sweep through the multiLevelPicker descriptor's
// getActive() (so each picker shows its own producer's curve + its committed
// picks); falls back to state.multiLevelSweep when shown standalone.

import { getState, subscribe } from "../state.js";
import { renderLine }          from "../charts/line.js";
import { getLayerDescriptor }  from "../modals/layer-descriptors.js";

export const ID          = "multilayer-curve";
export const LABEL       = "Pick layers";
export const DESCRIPTION = "Reproducibility vs. cluster count for an Optimise-multi-layer run. Click points to choose your coarse→fine layers, then Apply.";
export const SINGLETON   = true;

export function mount(container, _state, _config = {}) {
  // Local picked-set, seeded from the picker card's committed picks each time
  // a different sweep/card comes into view (tracked by uidPrefix).
  let picked = new Set();
  let seededFor = null;

  function readActive() {
    // Prefer the picker descriptor's view (knows the parent producer + the
    // card's committed picks). Fall back to the bare sweep slot.
    try {
      const a = getLayerDescriptor("multiLevelPicker").getActive();
      if (a && a.sweep) return a;
    } catch (_) { /* no picker selected — fall through */ }
    const sweep = getState().multiLevelSweep;
    return sweep
      ? { sweep, curve: sweep.curve, floor: sweep.floor, prevPicks: [], stepId: null }
      : null;
  }

  function render() {
    container.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "multilayer-curve-panel";

    const title = document.createElement("div");
    title.className = "multilayer-curve-title";
    title.textContent = "Pick layers";
    wrap.appendChild(title);

    const active = readActive();
    const curve = active && Array.isArray(active.curve) ? active.curve : null;

    if (!curve || curve.length === 0) {
      const empty = document.createElement("div");
      empty.className = "multilayer-curve-empty";
      empty.textContent =
        "No multi-layer sweep yet — run an Optimise multi-layer clustering " +
        "(the + under a dim-reduction card); a picker opens when it finishes.";
      wrap.appendChild(empty);
      container.appendChild(wrap);
      return;
    }

    // Seed the picked-set from the card's committed picks the first time this
    // sweep is shown (keyed by uidPrefix so switching cards re-seeds).
    const key = (active.sweep && active.sweep.uidPrefix) || "ML";
    if (seededFor !== key) {
      picked = new Set(active.prevPicks || []);
      seededFor = key;
    }
    // Drop picks that aren't valid candidate counts (defensive).
    const validCounts = new Set(curve.map(c => c.count));
    for (const c of [...picked]) if (!validCounts.has(c)) picked.delete(c);

    const summary = document.createElement("div");
    summary.className = "multilayer-curve-summary";
    summary.textContent =
      `${curve.length} candidate granularit${curve.length === 1 ? "y" : "ies"} · ` +
      `${picked.size} picked` +
      (picked.size ? ` (${[...picked].sort((a, b) => a - b).join(", ")} clusters)` : " — click points to choose");
    wrap.appendChild(summary);

    const chartHost = document.createElement("div");
    chartHost.className = "multilayer-curve-chart";
    wrap.appendChild(chartHost);

    const floor = Number.isFinite(active.floor) ? active.floor : 0.6;
    renderLine(chartHost, {
      points: curve.map(c => ({
        x:        c.count,
        y:        Number.isFinite(c.stability) ? c.stability : null,
        selected: picked.has(c.count),
        size:     c.plateauWidth,
        label:    `${c.count} clusters (mcs ${c.size})`,
      })),
      yMin: 0, yMax: 1, xLog: true,
      hline: floor,
      hlineLabel: `floor ${floor.toFixed(2)}`,
      xLabel: "cluster count", yLabel: "reproducibility",
      formatX: (v) => String(v),
      formatY: (v) => v.toFixed(2),
      chartW: Math.max(220, (container.clientWidth || 360) - 60),
      chartH: 200,
      onPointClick: (p) => {
        if (picked.has(p.x)) picked.delete(p.x);
        else picked.add(p.x);
        render();   // re-render to reflect the toggle
      },
    });

    // Apply / clear controls.
    const controls = document.createElement("div");
    controls.className = "multilayer-curve-controls";

    const applyBtn = document.createElement("button");
    applyBtn.className = "multilayer-curve-apply";
    applyBtn.textContent = picked.size
      ? `Apply ${picked.size} layer${picked.size === 1 ? "" : "s"}`
      : "Apply (pick at least one)";
    applyBtn.disabled = picked.size === 0 || !active.stepId;
    applyBtn.addEventListener("click", () => {
      applyBtn.disabled = true;
      applyBtn.textContent = "Committing…";
      getLayerDescriptor("multiLevelPicker")
        .applyChange({ pickedCounts: [...picked] })
        .catch(e => console.error("[multilayer-picker] apply failed:", e));
    });
    controls.appendChild(applyBtn);

    if (picked.size) {
      const clearBtn = document.createElement("button");
      clearBtn.className = "multilayer-curve-clear";
      clearBtn.textContent = "Clear";
      clearBtn.addEventListener("click", () => { picked.clear(); render(); });
      controls.appendChild(clearBtn);
    }

    wrap.appendChild(controls);
    container.appendChild(wrap);
  }

  render();
  const unsub = subscribe(() => render());
  return {
    update() { render(); },
    destroy() { unsub(); container.innerHTML = ""; },
  };
}
