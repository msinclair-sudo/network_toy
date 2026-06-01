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
    { label: "Optimise multi-layer clustering", hint: "Sweep HDBSCAN (leaf) → pick a coarse→fine layer ladder from the reproducibility curve", modal: "multiLevel" },
    { label: "Run dim sweep",           hint: "ARI stability across embedding dimensions", modal: "dimSweep" },
  ],
  clustering: [
    { label: "Run bootstrap stability", hint: "Per-cluster Jaccard via resampling", modal: "bootstrap" },
    { label: "Compare with another clustering", hint: "ARI / NMI / movers vs a second clustering", modal: "fusionComparison" },
    { label: "Run bridge analysis",     hint: "Fine clusters straddling ≥2 coarse parents (needs ≥2 levels)", modal: "bridgeAnalysis" },
    { label: "Label clusters",          hint: "Name clusters (representative paper / year / TF-IDF) for scoring", modal: "labelling" },
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
  // Producer (the sweep) — it does NOT materialise clusterLevels; the picker
  // child does. So the producer's only follow-on is the picker (auto-spawned
  // on completion; offered here too in case it was deleted) + re-run.
  multiLevel: [
    { label: "Re-run multi-layer",      hint: "Fork a fresh sweep with the same settings", rerun: true },
    { label: "Pick layers",             hint: "Open the reproducibility curve and choose layers", modal: "multiLevelPicker" },
  ],
  // Picker — once it commits a ladder (clusterLevels), it's clustering-
  // equivalent, so the analysis steps a clustering card spawns hang off it.
  // After committing a ladder the pipeline flows picker → bridge → labelling
  // → scoring (a bridge card auto-spawns; offered here too if it was deleted).
  // Labelling/scoring hang off the bridge card, not the picker directly.
  multiLevelPicker: [
    { label: "Run bridge analysis",     hint: "Per-layer: which clusters straddle ≥2 parents in the layer above", modal: "bridgeAnalysis" },
    { label: "Run bootstrap stability", hint: "Per-cluster Jaccard via resampling", modal: "bootstrap" },
    { label: "Compare with another clustering", hint: "ARI / NMI / movers vs a second clustering", modal: "fusionComparison" },
  ],
  bridgeAnalysis: [
    { label: "Re-run bridge analysis",  hint: "Recompute per-layer bridges across the ladder", rerun: true },
    { label: "Label clusters",          hint: "Name clusters (representative paper / year / KeyBERT) for scoring", modal: "labelling" },
  ],
  labelling: [
    { label: "Re-run labelling",        hint: "Fork a fresh run with the same methods", rerun: true },
    { label: "Prepare scoring",         hint: "Score these clusters 1–5 (opens in a Scoring panel)", modal: "scoring" },
  ],
  scoring: [
    { label: "Re-prepare scoring",      hint: "Re-snapshot labels/levels from upstream", rerun: true },
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
