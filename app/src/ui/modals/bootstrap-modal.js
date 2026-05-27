// Bootstrap-stability config modal — Phase 2 slice 2.9.a.
//
// Replaces the live config row that used to live inside the
// bootstrap-stability panel. Apply creates a `bootstrapStability`
// card under the selected clustering ancestor + enqueues a queue.js
// job; the panel renders saved-mode against the new card's result
// once the job lands.
//
// Mirrors the shape of dimred-modal / clustering-modal — config UI
// in the body, Cancel + Apply in the footer, Apply hands off to the
// descriptor which forks the card and enqueues.

import { openModal } from "./modal.js";
import { DEFAULT_MIN_MEMBERS } from "../../eval/bootstrap.js";

export function openBootstrapModal(descriptor) {
  const active = descriptor.getActive();    // { settings, hasClustering }

  // Working copy — committed only on Apply.
  let working = { ...active.settings };

  const body = document.createElement("div");
  body.className = "bootstrap-modal-body";

  if (!active.hasClustering) {
    const empty = document.createElement("div");
    empty.className = "bootstrap-modal-empty";
    empty.textContent = "Apply a clustering first (Clustering modal → Configure → Apply), then return here to run a bootstrap.";
    body.appendChild(empty);
    return openModal({
      title: descriptor.label,
      body,
      actions: [{ label: "Close" }],
    });
  }

  // Context header — what we'll bootstrap against.
  const ctx = document.createElement("div");
  ctx.className = "bootstrap-modal-context";
  ctx.textContent = `Reference: ${active.clusterLabel} · ${active.nClusters} clusters`;
  body.appendChild(ctx);

  // Config rows.
  const cfgHost = document.createElement("div");
  cfgHost.className = "bootstrap-modal-cfg";
  body.appendChild(cfgHost);

  cfgHost.appendChild(
    makeSlider("B", 5, 50, 1, working.B, (v) => { working.B = v; },
      "Bootstrap iterations. Hennig 2007 used 50; 10–25 is a working minimum.")
  );
  cfgHost.appendChild(
    makeSlider("subsampleFrac", 0.3, 0.9, 0.05, working.subsampleFrac, (v) => { working.subsampleFrac = v; },
      "Fraction of nodes resampled (without replacement) per iter. Hennig 2008 recommends 0.5.")
  );
  cfgHost.appendChild(
    makeNumber("minMembers", 1, 50, working.minMembers, (v) => { working.minMembers = v; },
      "Drop reference clusters with fewer than N in-subsample members from per-iter scoring (Hennig 2007 §3.2).")
  );
  cfgHost.appendChild(
    makeSelect("Noise handling", working.noiseHandling, [
      { value: "exclude",   label: "Exclude noise" },
      { value: "asCluster", label: "Treat noise as a cluster" },
      { value: "penalise",  label: "Penalise (× 1 − noise fraction)" },
    ], (v) => { working.noiseHandling = v; },
      "How -1 labels participate. Scores under different modes are not directly comparable.")
  );

  const modal = openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Apply",
        primary: true,
        onClick: () => {
          // Apply forks a card + enqueues a step-bound job. Modal closes
          // immediately; the chart card spins until the job completes.
          // Stays in-line with the slice 2.5 modal-as-step-creator
          // pattern.
          descriptor.applyChange({ ...working })
            .catch(e => console.error("[bootstrap-modal] applyChange failed:", e));
        },
      },
    ],
  });
  return modal;
}

// ── helpers (copy of panel's input builders; cheap shared idioms not
//    worth a new shared module yet — clustering-modal has its own too).

function makeSlider(labelText, min, max, step, init, onInput, hint) {
  const row = document.createElement("div");
  row.className = "bootstrap-modal-row";
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
  readout.className = "bootstrap-modal-readout";
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
  row.className = "bootstrap-modal-row";
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
  row.className = "bootstrap-modal-row";
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

// Defaults exported so the descriptor can seed `getActive` without
// reimporting from eval/bootstrap.js. Kept in sync with the panel's
// historical defaults (B=10, frac=0.5).
export const BOOTSTRAP_DEFAULTS = {
  B:             10,
  subsampleFrac: 0.5,
  minMembers:    DEFAULT_MIN_MEMBERS,
  noiseHandling: "exclude",
};
