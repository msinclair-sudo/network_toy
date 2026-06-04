# Multi-level clustering: leaf switch + producer/picker card split

**Status: SHIPPED 2026-06-01.** This file is kept as historical design
context. The producer/picker split + leaf default is live. Subsequent
cards.md Pass 1b (2026-06-03) added the bridge heatmap to the picker
panel; Pass 1c auto-spawned crossClusterCitations under the picker;
Pass 2a moved bridge computation into the picker's commit job (no
separate bridge card). Live palette + ordering: `cards.md`. Rationale:
`doc/plan.md` §10.

---

(Original plan below for historical reference.)

Replaces the current single
`multiLevel` card — no parallel paths, no dead code left behind.

## Why

Empirical probes on the biblion corpus (n=3109, UMAP-100; see
`scratch/probe_leaf_vs_eom.py`, `scratch/probe_leaf_bootstrap.py`):

- **EOM is unusable here** — collapses to 2 clusters at every
  `min_cluster_size` and every `min_samples` (one giant cluster = 56.5% of
  papers). Only 1 plateau candidate. This is the shipped default.
- **leaf gives a real ladder** — smooth coarse→fine curve, 16–17 plateau
  candidates; biggest cluster drops to 2–9%, spread from ~52 → ~9–13.
- **Bootstrap (B=10) confirms** leaf + `min_samples=15` yields 5 layers all
  clearing the 0.6 floor; candidates stay reproducible (≥0.6) up to ~28
  clusters. The old `capLayers=5` auto-cap was the binding constraint, not
  stability — it threw away genuinely-good fine layers.

Conclusion: switch the sweep to **leaf**, default **min_samples=15**, and
**replace the auto-`selectShelves` step with a human pick** on the
reproducibility-vs-count curve.

## Behaviour change

1. The sweep always uses `selectionMethod: "leaf"` (single-run clustering
   keeps its own EOM default — unchanged).
2. Default `min_samples` 5 → 15 in the multi-level modal.
3. The single `multiLevel` card becomes **two cards**:
   - **Card 1 — "Optimise: multi-layer sweep" (producer).** Runs Phase 1
     (size grid → candidates) + Phase 2 (bootstrap-score every candidate).
     Output = **all** scored candidates (each with its `clusterResult`) +
     the curve. **Does NOT run `selectShelves`** and does NOT build
     `clusterLevels[]`.
   - **Card 2 — "Pick layers" (picker), auto-spawned after Card 1.**
     Renders the curve as a clickable graph; the user clicks granularities
     to choose layers; an **Apply** button commits the picked candidates to
     `clusterLevels[]` (+ bridge/scoring/viewer).
4. `selectShelves` (floor + capLayers + 1.4× separation) is **removed** from
   the live path. `floor`/`capLayers` survive only as optional visual guides
   on the curve (floor line; no hard cap).

## The load-bearing change: retain all candidate clusterResults

Today `runPhase2AndSelect` keeps full `clusterResult`s only for the selected
shelves; unselected candidates' results are discarded
(`eval/multilayer-sweep.js:214`) and the curve is metadata-only. For the
picker to commit *any* clicked layer without re-running the sweep, Card 1
must retain every candidate's `clusterResult` (the `nodeCluster` array).

**Change:** split `runPhase2AndSelect` into two functions:
- `runPhase2Score({candidates, ...})` → bootstraps every candidate, returns
  `{ candidates }` where each candidate now carries `{count, size,
  plateauWidth, stability, clusterResult}` (the slim clusterResult,
  condensedTree already dropped — `nodeCluster` ~ 12 KB at n=3109, ×17 ≈
  200 KB, fine to hold in the card result).
- Delete `selectShelves` and the shelf-building tail (no longer used).

`recomputeMultiLevel` (engine) becomes `recomputeMultiLevelSweep`: runs
Phase 1 (worker) + `runPhase2Score` (main), writes `state.multiLevelSweep =
{ candidates, curve }`, and does **not** touch `clusterLevels`. A new
`commitMultiLevelLayers(pickedCounts)` builds `clusterLevels[]` from the
retained candidates + recomputes bridge/scoring — this is what Card 2's
Apply calls.

## Files touched (replace, don't duplicate)

| File | Change |
|---|---|
| `eval/multilayer-sweep.js` | Replace `runPhase2AndSelect` → `runPhase2Score` (keep all candidates' clusterResults). Delete `selectShelves` (+ its tests). Keep `logSpacedSizes`/`findPlateauCandidates`/`runPhase1`. |
| `clustering-hdbscan.js` | (No default change needed — leaf is injected via params. Optionally document.) |
| `ui/engine.js` | `recomputeMultiLevel` → produce-only (`recomputeMultiLevelSweep`); add `commitMultiLevelLayers(pickedCounts)`. |
| `ui/runners/multi-level-runner.js` | Producer job returns `{ candidates, curve, settings }` (no clusterLevels). |
| `ui/runners/` (new) | `multi-level-picker-runner.js` — Apply job → `commitMultiLevelLayers`. |
| `ui/modals/multi-level-modal.js` | Default min_samples 15; drop `capLayers` row (or keep as a guide only); leaf is implicit. |
| `ui/modals/layer-descriptors.js` | `multiLevelDescriptor`: params `{minSamples, selectionMethod:"leaf"}`; default 15. Add `multiLevelPickerDescriptor`. After Card 1 job completes, auto-create + select Card 2. New `case "multiLevelPicker"`. |
| `ui/next-steps-rules.js` | multiLevel rules: the downstream steps now hang off the **picker** card (bridge/label/etc. need committed `clusterLevels`). Producer card's only child is the picker. |
| `ui/panels/multilayer-curve.js` | Wire `onPointClick` (chart already supports it); render picked/selected state; this becomes the picker panel (or a new `multilayer-picker.js` extending it). |
| `ui/panels/registry.js` | Register the picker panel if separate. |
| `ui/workflow-projection.js` | Project producer card → `multiLevelSweep`; picker card → `clusterLevels`. |
| `persistence/` | Producer card result now holds `candidates` (with clusterResults) — confirm serialise/deserialise handles the larger result; bump SCHEMA_VERSION if shape breaks. |
| `tests/` | Replace `test_multilayer_sweep.py` selectShelves tests with runPhase2Score + commit tests; update `test_multilevel.py`. |

## Auto-spawn mechanism (Card 1 → Card 2)

No existing "job completion creates a card" hook. Cleanest: in
`multiLevelDescriptor.applyChange`, after `enqueueJob(...)`, attach to the
returned `promise` — on resolve, call the picker descriptor's
`applyChange`/`createStep` with `parentId = producerStepId`, then
`selectStep`. (Same `promise.then` site that today does `.catch`.) Keeps the
mechanism local to the descriptor, no queue.js change.

## Open questions for review

1. **Producer card with no committed layers** — until the user picks, the
   producer card has a curve but no `clusterLevels`. The viewer shows
   nothing cluster-coloured until Apply. OK? (Alternative: producer
   auto-commits a sensible default pick that the user then edits — but you
   chose pure manual.)
2. **capLayers** — drop the modal row entirely, or keep it as a soft guide
   line on the curve? (Plan assumes drop; floor stays as a guide line.)
3. **Re-pick after Apply** — picker card is re-selectable; re-clicking +
   Apply rebuilds `clusterLevels`. Confirm that's the intended edit loop.
4. **Persistence** — RESOLVED: persistence saves only the legacy state
   slots (incl. committed `clusterLevels`), NOT the workflow tree or
   `state.multiLevelSweep`. So a saved project keeps the committed ladder and
   loads unchanged; the producer's cached `candidates` are not saved (re-run
   the sweep to re-pick after load). No SCHEMA_VERSION bump needed.
```
