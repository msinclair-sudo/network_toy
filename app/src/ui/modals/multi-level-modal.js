// Multi-level ("Optimise multi-layer") clustering config modal — MLC §9.
//
// One HDBSCAN run → a coarse→fine ladder of partitions extracted from the
// condensed tree. The user sets the HDBSCAN granularity (minClusterSize /
// minSamples) and the layer cap; Apply creates a `multiLevel` card under
// the selected dimred ancestor and enqueues the run.
//
// Mirrors dim-sweep / fusion-comparison modals: config in the body,
// Cancel + Apply in the footer.

import { openModal } from "./modal.js";

export function openMultiLevelModal(descriptor) {
  const active = descriptor.getActive();   // { hasDimred, n, defaults, parentId }

  const body = document.createElement("div");
  body.className = "multi-level-modal-body";

  if (!active.hasDimred) {
    const empty = document.createElement("div");
    empty.className = "multi-level-modal-empty";
    empty.textContent =
      "Multi-layer clustering needs a dim-reduction card to run on. Add a " +
      "dim-reduction step first (the + under a data card), then return here.";
    body.appendChild(empty);
    return openModal({ title: descriptor.label, body, actions: [{ label: "Close" }] });
  }

  const intro = document.createElement("div");
  intro.className = "multi-level-modal-intro";
  intro.textContent =
    "Run HDBSCAN once and extract a coarse→fine ladder of cluster layers " +
    "from its condensed tree (no repeated sweeps). Noise-stripped points " +
    "are absorbed into the nearest cluster, so a fine cluster can bridge " +
    "two coarse parents. The viewer's colour-by-layer mode shows each level.";
  body.appendChild(intro);

  const d = active.defaults;
  const cfg = document.createElement("div");
  cfg.className = "multi-level-modal-cfg";
  body.appendChild(cfg);

  const minClusterSize = numberRow(cfg, "Min cluster size",
    d.minClusterSize, 2, Math.max(2, (active.n || 1000)),
    "Smallest cluster HDBSCAN will keep. Larger ⇒ coarser, fewer layers.");
  const minSamples = numberRow(cfg, "Min samples",
    d.minSamples, 1, Math.max(1, (active.n || 1000) - 1),
    "HDBSCAN density smoothing (k for core distance).");
  const capLayers = numberRow(cfg, "Max layers",
    d.capLayers, 2, 5,
    "Hard cap on discovered layers (data-derived, ≤ 5).");

  const warn = document.createElement("div");
  warn.className = "multi-level-modal-warn";
  body.appendChild(warn);

  return openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Run",
        primary: true,
        onClick: () => {
          const mcs = clampInt(minClusterSize.value, 2, active.n || 1000, d.minClusterSize);
          const ms  = clampInt(minSamples.value, 1, (active.n || 1000) - 1, d.minSamples);
          const cap = clampInt(capLayers.value, 2, 5, d.capLayers);
          descriptor.applyChange({ minClusterSize: mcs, minSamples: ms, capLayers: cap })
            .catch(e => console.error("[multi-level-modal] applyChange failed:", e));
        },
      },
    ],
  });
}

function numberRow(parent, labelText, value, min, max, hint) {
  const row = document.createElement("div");
  row.className = "multi-level-modal-row";
  const lab = document.createElement("label");
  lab.textContent = labelText;
  const input = document.createElement("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.value = String(value);
  row.appendChild(lab);
  row.appendChild(input);
  if (hint) {
    const h = document.createElement("div");
    h.className = "multi-level-modal-hint";
    h.textContent = hint;
    row.appendChild(h);
  }
  parent.appendChild(row);
  return input;
}

function clampInt(raw, min, max, fallback) {
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}
