// Bridge-analysis config modal — first "analysis layer" card.
//
// Bridges are a PER-LAYER relationship (§9): for every committed layer i ≥ 1,
// each cluster in layer i is checked against the clusters in the layer above
// (i − 1). There's no fine/coarse pair to pick — the run covers all layers —
// so this modal just confirms + runs. Apply forks a `bridgeAnalysis` card
// under the selected clustering-like ancestor (the layer picker) and enqueues
// the runner. Needs a parent with ≥ 2 levels.

import { openModal } from "./modal.js";

export function openBridgeAnalysisModal(descriptor) {
  const active = descriptor.getActive();   // { hasClustering, nLevels }

  const body = document.createElement("div");
  body.className = "bridge-modal-body";

  if (!active.hasClustering || active.nLevels < 2) {
    const empty = document.createElement("div");
    empty.className = "bridge-modal-empty";
    empty.textContent = active.hasClustering
      ? "Bridge analysis needs a clustering with at least two layers — pick a ladder from a multi-layer sweep first."
      : "Pick a multi-layer ladder first (sweep → pick layers), then run bridge analysis on it.";
    body.appendChild(empty);
    return openModal({ title: descriptor.label, body, actions: [{ label: "Close" }] });
  }

  const ctx = document.createElement("div");
  ctx.className = "bridge-modal-context";
  ctx.textContent =
    `${active.nLevels} layers. For every layer below the coarsest, each cluster ` +
    `is checked against the clusters in the layer above it — flagging the ones ` +
    `that straddle ≥ 2 parents (bridges) vs. those with one dominant parent ` +
    `(encapsulated). Runs across all layers.`;
  body.appendChild(ctx);

  return openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Run",
        primary: true,
        onClick: () => {
          descriptor.applyChange()
            .catch(e => console.error("[bridge-analysis-modal] applyChange failed:", e));
        },
      },
    ],
  });
}
