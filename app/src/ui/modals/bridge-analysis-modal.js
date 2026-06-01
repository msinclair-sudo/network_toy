// Bridge-analysis config modal — first "analysis layer" card.
//
// Picks the fine/coarse level pair to compare; Apply forks a
// `bridgeAnalysis` card under the selected clustering-like ancestor and
// enqueues the runner. Needs a parent with ≥2 levels (a multi-layer card
// or a multi-level clustering) — otherwise there's no pair to compare.
//
// Mirrors bootstrap-modal: config in the body, Cancel + Apply in the
// footer, Apply hands off to descriptor.applyChange.

import { openModal } from "./modal.js";

export function openBridgeAnalysisModal(descriptor) {
  const active = descriptor.getActive();   // { hasClustering, nLevels, fineLevel, coarseLevel }

  const body = document.createElement("div");
  body.className = "bridge-modal-body";

  if (!active.hasClustering || active.nLevels < 2) {
    const empty = document.createElement("div");
    empty.className = "bridge-modal-empty";
    empty.textContent = active.hasClustering
      ? "Bridge analysis needs a clustering with at least two levels — run it on a multi-layer card (or a multi-level clustering)."
      : "Add a clustering or multi-layer card first, then run bridge analysis on it.";
    body.appendChild(empty);
    return openModal({ title: descriptor.label, body, actions: [{ label: "Close" }] });
  }

  // Working pair — committed only on Apply.
  let working = { fineLevel: active.fineLevel, coarseLevel: active.coarseLevel };

  const ctx = document.createElement("div");
  ctx.className = "bridge-modal-context";
  ctx.textContent = `${active.nLevels} levels — pick a fine cluster level and a coarser parent level to compare it against.`;
  body.appendChild(ctx);

  const cfg = document.createElement("div");
  cfg.className = "bridge-modal-cfg";
  body.appendChild(cfg);

  // Fine selector: levels 1 … nLevels-1 (L0 has no coarser parent to span).
  cfg.appendChild(makeSelect("Fine level", working.fineLevel,
    range(1, active.nLevels - 1).map(i => ({ value: i, label: `L${i}` })),
    (v) => {
      working.fineLevel = v;
      if (working.coarseLevel >= v) working.coarseLevel = v - 1;
      rebuildCoarse();
    },
    "The fine partition whose clusters are histogrammed against the coarse level."));

  // Coarse selector: 0 … fineLevel-1, rebuilt whenever the fine level changes.
  const coarseHost = document.createElement("div");
  cfg.appendChild(coarseHost);
  function rebuildCoarse() {
    coarseHost.innerHTML = "";
    coarseHost.appendChild(makeSelect("Coarse level", working.coarseLevel,
      range(0, working.fineLevel - 1).map(j => ({ value: j, label: `L${j}` })),
      (v) => { working.coarseLevel = v; },
      "The coarser parent level each fine cluster's members are attributed to."));
  }
  rebuildCoarse();

  return openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Apply",
        primary: true,
        onClick: () => {
          descriptor.applyChange({ ...working })
            .catch(e => console.error("[bridge-analysis-modal] applyChange failed:", e));
        },
      },
    ],
  });
}

function range(lo, hi) {
  const out = [];
  for (let i = lo; i <= hi; i++) out.push(i);
  return out;
}

function makeSelect(labelText, init, options, onChange, hint) {
  const row = document.createElement("div");
  row.className = "bridge-modal-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  if (hint) lab.title = hint;
  row.appendChild(lab);
  const sel = document.createElement("select");
  for (const opt of options) {
    const o = document.createElement("option");
    o.value = String(opt.value);
    o.textContent = opt.label;
    if (opt.value === init) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => onChange(parseInt(sel.value, 10)));
  row.appendChild(sel);
  return row;
}
