// New UI bootstrap.
//
// Imports each UI section module and mounts it into its DOM slot.
// Each module is responsible for its own rendering, state subscription,
// and event handling.
//
// Engine wiring (generation, clustering, citations, layout, blend) is
// not connected in this slice — see doc/ui.md §9 for the build phasing.
// Modules below render placeholder content where the engine isn't yet
// wired; the layout shell is fully functional.
//
// Legacy UI is preserved at app/legacy.html for comparison.

import { mountTopbar }         from "./topbar.js";
import { mountDataPanel }      from "./data-panel.js";
import { mountWorkflowChart }  from "./workflow-chart.js";
import { mountPanelSystem }    from "./panel-system.js";
import { setBlend, getState, subscribe } from "./state.js";
import * as engine             from "./engine.js";

export function boot() {
  mountTopbar();
  mountDataPanel();
  mountWorkflowChart();
  mountPanelSystem();
  mountBlendSlider();

  // Run the toy pipeline once so the 3D viewer has data on first
  // paint. Wrapped in rAF so the panel system has finished mounting
  // its initial DOM (the viewer-3d panel queries its container size
  // from layout).
  requestAnimationFrame(() => {
    try { engine.regenerate(); }
    catch (e) { console.error("[ui] initial pipeline run failed:", e); }
  });

  console.log("[ui] shell mounted; engine wired.");
}

function mountBlendSlider() {
  const input    = document.getElementById("blend-slider");
  const readout  = document.getElementById("blend-readout");
  if (!input || !readout) return;

  input.value = String(getState().blend);
  readout.textContent = (+input.value).toFixed(2);

  input.addEventListener("input", (e) => {
    const v = +e.target.value;
    setBlend(v);
    readout.textContent = v.toFixed(2);
  });

  // Keep in sync if state changes elsewhere.
  subscribe((state) => {
    if (Math.abs(+input.value - state.blend) > 1e-9) {
      input.value = String(state.blend);
      readout.textContent = state.blend.toFixed(2);
    }
  });
}
