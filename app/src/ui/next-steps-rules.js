// Next-step rule table — shared by the next-steps panel (slice 2.12)
// and the workflow chart's per-card "+" add-step button (UI #2).
//
// A STATIC lookup from step.type → valid follow-on actions. Each action
// either opens a layer descriptor's modal ("modal", creating a new
// downstream card on Apply) or re-runs the selected card ("rerun").
// No ML, no compute-time estimation — just the rule table.

import { getLayerDescriptor, rerunStep } from "./modals/layer-descriptors.js";

export const NEXT_STEP_RULES = {
  data: [
    { label: "Configure dim-reduction", hint: "PCA / UMAP / fusion → a dimred card", modal: "dimred" },
  ],
  dimred: [
    { label: "Configure clustering",    hint: "HDBSCAN / mutual-kNN → a clustering card", modal: "clustering" },
    { label: "Optimise multi-layer clustering", hint: "One HDBSCAN run → a coarse→fine layer ladder", modal: "multiLevel" },
    { label: "Run dim sweep",           hint: "ARI stability across embedding dimensions", modal: "dimSweep" },
  ],
  clustering: [
    { label: "Run bootstrap stability", hint: "Per-cluster Jaccard via resampling", modal: "bootstrap" },
    { label: "Compare with another clustering", hint: "ARI / NMI / movers vs a second clustering", modal: "fusionComparison" },
    { label: "Run dim sweep",           hint: "ARI stability across embedding dimensions", modal: "dimSweep" },
    { label: "Configure citation layout", hint: "Force-directed layout from citation edges", modal: "layout" },
  ],
  citationLayout: [
    { label: "Reconfigure layout",      hint: "Tune the citation-layout algorithm", modal: "layout" },
  ],
  bootstrapStability: [
    { label: "Re-run this bootstrap",   hint: "Fork a fresh run with the same settings", rerun: true },
  ],
  dimSweep: [
    { label: "Re-run this dim sweep",   hint: "Fork a fresh sweep with the same settings", rerun: true },
  ],
  fusionComparison: [
    { label: "Re-run this comparison",  hint: "Fork a fresh comparison of the same pair", rerun: true },
    { label: "Compare a different pair", hint: "Pick two clusterings to compare", modal: "fusionComparison" },
  ],
  multiLevel: [
    { label: "Re-run multi-layer",      hint: "Fork a fresh run with the same settings", rerun: true },
  ],
};

/**
 * All follow-on rules for a step type (panel uses these — includes
 * rerun actions).
 * @param {string} stepType
 * @returns {Array<{label, hint, modal?, rerun?}>}
 */
export function nextStepsFor(stepType) {
  return NEXT_STEP_RULES[stepType] || [];
}

/**
 * Just the "add a downstream card" rules (the "+" button uses these —
 * excludes rerun-this-card actions, which aren't "next steps").
 * @param {string} stepType
 */
export function addStepRulesFor(stepType) {
  return nextStepsFor(stepType).filter(r => r.modal && !r.rerun);
}

/**
 * Run a rule against a step: rerun the card, or open the descriptor's
 * modal (which forks a new card on Apply).
 * @param {object} step
 * @param {{modal?: string, rerun?: boolean}} rule
 */
export function runNextStepAction(step, rule) {
  if (rule.rerun) {
    rerunStep(step.id).catch(e => console.error("[next-steps] rerun failed:", e));
    return;
  }
  const desc = getLayerDescriptor(rule.modal);
  if (desc && desc.openModal) desc.openModal();
  else console.warn(`[next-steps] no descriptor/openModal for "${rule.modal}"`);
}
