# Workflow-tree redesign

**Status:** design draft, in flight (2026-05-26). Iterating with the
project lead before any code lands.

**Why this exists.** The toy has accumulated substantial analysis
machinery — multi-stage dim-reduction, multi-level clustering,
bootstrap stability, target-range sweeps, fusion comparison, dim
sweeps, bridge analysis. The machinery works. What's not working is
the UX *around* it: a user who opens the toy doesn't have a clear path
through, doesn't see what's been done on this dataset, can't queue
work and walk away, and can't branch — try clustering A and clustering
B side-by-side as siblings on the same data.

The proposed shift: **the workflow tree becomes the primary surface.**
The viewer demotes to an abstraction of the data. The user grows a
branching tree of analysis steps; each step runs in a queue; each
step's result is stored and renderable as a panel.

## 1. Vision

The toy today is **viewer-centric**: the 3D viewer dominates the
layout, modals are the primary configuration surface, and the
workflow chart is a small status indicator on the left rail. Analysis
results land in slots on `state` and you read them by knowing which
panel surfaces which slot.

The toy tomorrow is **workflow-centric**:

- The user works against a tree of analysis steps they grew. Adding a
  step is the primary action; configuring it is secondary.
- Steps queue themselves. The user can fire-and-forget — start an
  Optimise sweep, walk away, return to a finished run pinned in the
  tree.
- Each step's result is a first-class entity (already started with
  `state.validationRuns` in §6.19.1). The tree is the index;
  validationRuns is the store.
- Branching is native: from any data step the user can fork multiple
  dim-reductions, multiple clusterings per dim-reduction, multiple
  fusion comparisons, etc. Each branch lives independently.
- The viewer is one renderer among many. Its job is to show a 3D
  abstraction of *some* step's geometry — never the authoritative
  state.

> This isn't about removing the viewer. It's about re-centring the UX
> so the user's mental model is "what have I run, what's running, what
> can I run next" rather than "what does the screen look like."

## 2. Current-state audit

Surface-by-surface inventory of what's there today, what it does,
what's broken, and what gets repurposed.

### 2.1 Workflow chart (`app/src/ui/workflow-chart.js`)

- **What it does**: SVG DAG of 7 hand-positioned layer nodes
  (data → dimred → clustering → citations → layout → alignment →
  blend) on the left rail. Each click opens its modal. Status dot per
  node (fresh / stale / running / not-run).
- **What it isn't**: a tree. It's a fixed linear chain mirroring the
  six-layer pipeline. No branching, no per-step persistence, no
  history. The user can't have two clusterings side-by-side.
- **Repurpose**: becomes the renderer for the new workflow tree.
  Existing layer-state colour coding stays; layout becomes
  graph-based (force or hierarchical) instead of hand-positioned.

### 2.2 Topbar (`app/src/ui/topbar.js`)

- **What it does**: five drop-down menus (File / Data / Workflow /
  Validate / Help) + seed display.
- **What's dead**: 7 of 12 items are `disabled: true` stubs:
  - Data → Load real dataset, Citation source, Export labels, Export edges
  - Workflow → Save preset, Load preset
  - Validate → ARI dim-sweep, Cluster-vs-cluster disagreement
  - Help → Method manual, Keyboard shortcuts
- **What needs cleanup**: the disabled items create UX noise. Some
  are subsumed (ARI dim-sweep is now a panel; bootstrap-Jaccard is
  inside Optimise). Some are speculative (presets, method manual).
- **Repurpose**: File stays (Save / Save as / Load). Data, Workflow,
  Validate get audited per the tree model — they may collapse into
  the tree itself (an "Add step" button replaces most of them).

### 2.3 Modals

- `data-source-modal.js`, `dimred-modal.js`, `clustering-modal.js`
  (tabbed: Configure / Optimise), `algorithm-modal.js` (used by
  citation layout). All open from workflow-chart node clicks.
- **What's broken UX-wise**:
  - **Optimise modal must stay open while the sweep runs.** This is
    the user's primary pain. Cancelling = closing the modal. Running
    a second analysis = waiting.
  - Modal Apply mutates the canonical state immediately. There's no
    "stash this config, queue it, walk away" path.
  - Some modals are one-shot (data, dimred) and some are stateful
    (clustering with multi-tab); the difference isn't obvious.
- **Repurpose**: modals become "configure this step" forms. They
  *create* a step in the tree (with config + status=pending) and
  close immediately. The step then runs in the queue.

### 2.4 Panels (`app/src/ui/panels/`)

- **Registered today (11)**: viewer-3d, viewer-2d, node-table,
  validation-run-optimise, method-receipt, bootstrap-stability,
  bridge-analysis, dim-sweep, fusion-comparison, placeholder.
- **What works**: many are already dual-mode (live + saved). The
  saved-mode pattern is exactly what the tree wants — a panel bound
  to a step's result.
- **Repurpose**: panels are renderers, parameterised by a step id.
  Live mode disappears (or becomes "render the tree's currently-
  selected step"). The panel-picker becomes "pick a step from the
  tree to render".

### 2.5 Busy bar + queue (`app/src/ui/busy.js`, `#busy-bar`)

- **What it does**: §6.13's FIFO job queue. `enqueueBusy(label, fn)`
  appends; jobs run sequentially. Cascade phases via `setBusyPhase`.
  Bottom bar shows current label + phase + `+N queued` count.
- **What's not there**: there's no concept of *what* is queued, only
  the running label. No cancel per job. No retry. No history of
  completed jobs. The queue is an implementation detail, not a
  user-facing surface.
- **Repurpose**: the queue becomes the tree's runtime. Each tree step
  is a queue job; the bottom bar still shows the head label, but the
  authoritative view is the tree itself (with status dots per step).

### 2.6 ValidationRuns (`state.validationRuns`)

- **What it is**: §6.19.1 first-class persistent entities. Each entry
  has `{id, type, label, timestamp, inputs, settings, results,
  scoreVersion, runtimeSec}`. Survives project save/load.
- **What it isn't**: a tree. It's a flat list with no parent/child
  relationships. A saved Optimise run doesn't know *which*
  dim-reduction or *which* clustering it was scored against.
- **Repurpose**: this is the store. Each tree step's result lives
  here (extended to non-`validation` types if needed). The tree adds
  the parent/child topology on top.

### 2.7 State container (`app/src/ui/state.js`)

- Slots: dataSource, layerParams, layerStates, activeAlgorithm,
  genResult, embedding, _basePos,_basePos2d, dimredResult,
  dimredResultPreFusion, clusterLevels, clusterLevelsPreFusion,
  bridgeAnalysis, bridgeConfig, citationResult, citationLayout,
  alignedCitationLayout, alignmentCorrelation, neighbourhoodResult,
  tasteResult, evalResults, validationRuns, selection, blend, view,
  panels, busy.
- **What's load-bearing**: layerParams (the *current* config),
  clusterLevels + dimredResult + basePos (the *current* result),
  validationRuns (history of save-this-runs).
- **What's awkward**: the "current" slots are singular. To branch
  ("try clustering A vs B on the same dimred"), you need two
  separate clusterings without one stomping the other. Today this
  isn't possible — clustering A's result is in `clusterLevels`,
  running clustering B replaces it.
- **Repurpose**: a `state.workflow` slot holds the tree. The "current"
  slots become *cached projections* of whichever step is selected as
  the viewer's source. Live + canonical separate cleanly.

### 2.8 Engine cascade (`app/src/ui/engine.js`)

- **What it does**: when a layer's params change, downstream layers
  re-run. The cascade is hard-coded (redimred → recluster → etc.).
- **What's awkward**: cascade only knows about the *current* path.
  Branching is impossible — there's only one downstream chain per
  layer.
- **Repurpose**: the engine becomes a per-step runner. Each step
  type has a runner; the tree-walker invokes runners in topological
  order. No global cascade; each step explicitly depends on its
  parent's result.

### Summary of the audit

| Surface | What's there | Repurpose |
|---|---|---|
| Workflow chart | Fixed 7-node linear chain | Tree renderer (branching, persistent steps) |
| Topbar menus | 7 of 12 items are dead stubs | Trim; "Add step" replaces most |
| Modals | Block UI during apply | "Configure step" forms; create+close |
| Panels | Already dual-mode for some | All become step-result renderers |
| Busy bar | FIFO queue, not user-facing | Becomes the tree's runtime |
| ValidationRuns | Flat list of saves | Tree's step-result store |
| State slots | Singular "current" slots | Cached projection of selected step |
| Engine cascade | Hard-coded linear chain | Per-step runner invoked by tree walker |

The good news: a lot of the machinery the tree model needs is
already in place. We're not building from scratch — we're re-centring
the UX around components that already exist.

## 3. Target architecture

### 3.1 The tree shape

```
state.workflow = {
  steps: { [id]: Step },        // node store, keyed by step id
  rootId: "step-data-1",         // tree root (always a data step)
  selected: "step-cluster-7",    // which step the viewer + panels render
}

type Step = {
  id:        string,             // stable across saves
  type:      "data" | "dimred" | "clustering" | "optimise" |
             "bootstrapStability" | "fusionComparison" |
             "dimSweep" | "bridgeAnalysis" | "citationLayout" | ...
  label:     string,             // user-editable; defaults to type + key params
  params:    object,             // type-specific config
  parentId:  string | null,      // null only for root
  childIds:  string[],           // ordered (the user's preferred display order)
  refIds:    string[],           // OTHER steps this step references (for
                                  // multi-source comparisons like fusion)

  status:    "pending" | "running" | "done" | "failed" | "cancelled" | "stale",
  result:    object | null,      // type-specific; null when not done
  error:     string | null,      // when status === "failed"
  runtimeSec: number | null,

  createdAt: ISO string,
  startedAt: ISO string | null,
  endedAt:   ISO string | null,
}
```

Key shape decisions:

- **DAG, not strict tree.** `refIds` allows fan-in (a
  fusionComparison step that references two cluster steps as ref +
  cand). The tree renderer treats `parentId` as the primary edge
  and `refIds` as dashed cross-edges.
- **Steps are immutable once `done`.** Editing a "done" step's
  params creates a *new* step with the same parent. This preserves
  history; old branches stay browsable.
- **`stale` is computed, not stored.** When a parent's result
  changes (almost never, since done is immutable — but it can happen
  if the user explicitly re-runs), descendants become stale.
- **Re-running a step in place is the exception, not the rule.** The
  default action on a done step is "fork": create a sibling with
  edited params.

### 3.2 The queue

`state.workflow.queue` is an ordered list of step ids. The queue
runner picks the head, sets its status to `running`, invokes the
step's runner, then marks the result + transitions to `done` /
`failed`.

```
state.workflow.queue = ["step-cluster-7", "step-optimise-3"];
```

Concurrency: **one job at a time** in the first cut. Same as today's
busy.js. Multiple-jobs-in-flight is a follow-up; for now the user
queues, walks away, comes back to a chain of completed steps.

Mid-flight progress: each runner can call
`updateStepProgress(stepId, {phase, fraction})`. The tree renderer
shows this on the running step's node.

Cancel: per-step abort. Each running step's runner gets an
AbortSignal; cancel = `controller.abort()` + dequeue.

Failure: status `failed`, error stored on the step. Tree node shows
red dot. User can retry (re-enqueue) or fork (create a sibling with
adjusted params).

### 3.3 Step types (initial set)

Same set as today's panels + analyses, just first-class:

| Step type | Inputs | Result shape | Renderer panel |
|---|---|---|---|
| `data` | source id, config | `{n, hasEmbedding, hasCitations, ...}` | (data-info, new) |
| `dimred` | noise/fusion/compression/viz/viz2d configs | `{dimredResult, _basePos, _basePos2d}` | viewer-3d, viewer-2d |
| `clustering` | algo + levels | `{clusterLevels}` | node-table, viewer (coloured by cluster) |
| `optimise` | scorers + sweep mode + targets | `{ranked, scorer, settings}` | validation-run-optimise |
| `bootstrapStability` | B, frac, minMembers, noise mode | `{aggregate, perCluster, ...}` | bootstrap-stability |
| `fusionComparison` | refStepId, candStepId (refIds) | `{aggregate, perCluster, perNode, topMovers}` | fusion-comparison |
| `dimSweep` | dims, seeds, noise/comp/clust configs | `{ariMatrix, clusterCounts, ...}` | dim-sweep |
| `bridgeAnalysis` | (fineLevel, coarseLevel) | `{perCluster, perNode, ...}` | bridge-analysis |
| `citationLayout` | algo + params | `{citationLayout, aligned, correlation}` | viewer-3d (overlay) |

New step types added later (auto-recursion, partition-comparison,
custom) slot in here without architectural change.

### 3.4 Selection + the viewer

`state.workflow.selected` points to one step id. The viewer panels
read whichever step is currently selected and render it (or render
the most recent ancestor that produced a basePos, for non-geometric
steps like optimise). Selecting a different tree node = the viewer
repaints to that step's data.

This decouples "what's the viewer showing" from "what's the most
recently-mutated state slot". The user can leave the viewer on
clustering-A while running an Optimise on clustering-B's branch.

### 3.5 Persistence

`state.workflow` rides along in the existing `.zip` save format. The
flat `validationRuns` slot becomes a synonym for "all step results"
(or stays as a back-compat alias and we walk the tree to recover
it). Old saved projects get migrated by reconstructing a linear tree
from the existing state slots (data → dimred → clustering →
citations → layout → alignment → blend, all with `status: "done"`
and the existing result blobs).

## 4. Step types (configuration detail)

(Section 3.3 lists them; this section will fill in per-type config
schemas and runner interfaces during Phase 1. Deferred from this
draft — too speculative without the queue + tree shipped.)

## 5. Queue semantics (mid-flight detail)

(Detailed protocol — what happens on cancel, retry, mid-flight
progress, parallel branches. Deferred until the basic queue lands;
the §6.13 FIFO is the v1.)

## 6. Relationship to existing surfaces

| Existing | Becomes |
|---|---|
| `state.layerParams.*` | "current path" projection from selected step |
| `state.clusterLevels` etc. | cached projection of the selected clustering step |
| `state.layerStates.*` | per-step `status` field on each tree node |
| `state.validationRuns` | step-result storage (extended types) |
| `state.evalResults.optimise` | latest optimise step's result; phased out |
| `enqueueBusy` | the queue's enqueue action (renamed `enqueueStep`?) |
| `setBusyPhase` | `updateStepProgress(stepId, {phase})` |
| Workflow chart | tree renderer |
| Topbar menus | trimmed; "Add step" button replaces most |
| Modals | step-config forms (create + close, no apply-and-wait) |
| Panels | step-result renderers |

## 7. Phased delivery plan

Three phases. Each is independently shippable; each makes the toy
more useful even if subsequent phases never land.

### Phase 1 — Modal independence (the immediate pain)

**Goal.** The Optimise (and similar long-running) modal no longer
has to stay open. Apply enqueues a job that runs in the background;
the modal closes immediately. The user picks the resulting config
from the saved sweep later.

**Concretely.**

- New `app/src/ui/queue.js` (or extend `busy.js`): typed-job queue
  where each job has a stable id, status, and result. Replaces
  raw `enqueueBusy` for analyses (keeps it for save/load).
- The Optimise tab's Run button enqueues; the modal can close mid-
  run. Result lands in `state.validationRuns` automatically (no
  Save-this-run click required — already runs are auto-saved).
- Bottom busy bar shows job ids alongside the head label; tooltip
  reveals queued jobs. Click a queued job → cancel.
- The Optimise tab on reopen shows the queue + the latest result
  inline; the user can pick a config from any completed run.
- Bootstrap-stability + dim-sweep get the same treatment for free.

**Doesn't include.** Tree shape, branching, step migration. This
phase just makes the existing surfaces non-blocking.

**Effort.** Medium. Touches busy.js, the three long-running modal
surfaces, the save path. ~1 week of careful work.

### Phase 2 — Workflow tree expansion

**Goal.** The workflow chart becomes a branching tree. Each completed
analysis is a tree node. The user can add steps, fork from any
node, view per-node results.

**Concretely.**

- `state.workflow` slot + Step shape + tree CRUD actions.
- Migration: existing `state.layerParams` + result slots get
  reconstructed as a linear tree on first load.
- Workflow chart re-renders the tree (force-directed or
  hierarchical layout; switch from hand-positioned).
- Each tree node is clickable: opens the step's renderer panel as
  the selection target.
- "Add step" button per node: opens the step-type picker → opens
  the step's config modal → on Apply, enqueues the step.
- Existing modals adapt: their "Apply" creates a new tree step
  (sibling of the currently-selected step's parent, in most cases)
  rather than mutating state directly.
- Old `state.clusterLevels` etc. become read-only projections from
  the selected step.

**Doesn't include.** Cross-source step types (fusion-comparison
between two arbitrary clusterings). Those come in Phase 3.

**Effort.** Large. The tree CRUD + migration + per-modal-adapter is
substantial. ~3 weeks. Highest risk for breaking existing behaviour;
warrants careful staging and a regression smoke per existing panel.

### Phase 3 — Cross-source steps + next-step affordances + dead-UX cleanup

**Goal.** Polish the tree so users have a clear path through.

**Concretely.**

- Cross-source steps land: `fusionComparison` becomes the canonical
  comparison renderer for *any* two cluster sources, not just
  pre/post fusion. Step picker per slot.
- "Next step" affordances per tree node: a small "what next?" panel
  showing valid follow-ons based on the current node's type and
  result.
- Topbar audit: kill all 7 disabled stubs that aren't on the
  roadmap; keep the rest. Restructure menus around tree operations.
- Workflow chart: pan/zoom; collapse subtrees; node hover preview.
- "Method receipt" panel becomes tree-walking — emits the
  defensibility paragraph based on the selected step's full
  ancestry.

**Effort.** Medium. Polish + cleanup; lower risk than Phase 2.
~1–2 weeks.

## 8. Migration / back-compat

Old saved projects load. The deserialiser detects whether
`state.workflow` is present:

- **Present**: use as-is.
- **Absent**: reconstruct from `state.layerParams` + existing result
  slots. Build a linear tree: data → dimred → clustering →
  (optionally) citations → layout → alignment → blend, all done.
  `validationRuns` get reattached to their nearest matching step by
  `inputs.dataSourceId` + `inputs.layerParamsSnapshot` heuristic.

Existing modals stay during the transition. Phase 2's adapter layer
makes them create-step instead of mutate-state, but they don't
disappear. Phase 3 may collapse some into the tree's step-picker.

Schema version bump on the save format the moment Phase 2 lands.
Older saves still load (the absent-`state.workflow` branch handles
them); the bump is forward-compat protection.

## 9. What this is NOT

- **Not an engine rewrite.** The algorithms — UMAP, HDBSCAN, FR,
  graph-diffusion, bipartite-match, etc. — don't change. The runners
  wrap them; the registries stay; the contracts stay.
- **Not a different state container.** `state.js`'s vanilla
  `getState / update / subscribe` stays. `state.workflow` is a new
  slot, not a new container.
- **Not removing the viewer.** The viewer panel stays — it just
  isn't the centrepiece any more. A user who wants the
  viewer-dominated layout can pin it as the largest panel; the tree
  becomes a side rail. Default layout shifts the emphasis.
- **Not a new abstraction layer over algorithms.** Existing
  `dimred/registry.js`, `clustering-registry.js`,
  `citation-layout/registry.js`, `eval/scorers.js` etc. all stay
  exactly as they are.
- **Not a queue rewrite.** `busy.js`'s FIFO is the basis. We extend
  it (typed jobs, per-job cancel) but don't replace.

## 10. Open design questions

Things I can't resolve alone — flagged for discussion before coding.

### 10.1 Tree vs strict DAG

`refIds` allows fan-in (fusionComparison references two clusterings).
Strict tree forbids this; user has to pick a "primary" parent. DAG
allows the natural shape but harder to render and reason about
(cycles? merge nodes? topological sort?).

**Lean**: DAG with no cycles (enforced at refIds-add time). Renderer
treats `parentId` as the primary edge, `refIds` as dashed
back-references.

### 10.2 What invalidates a parent's children?

If the user re-runs a `dimred` step in place (rare path, since the
default is fork), do all its `clustering` children re-run
automatically? Or stay stale until the user acts?

**Lean**: stale, not auto-rerun. Auto-cascade was the source of
several historical UX pains (citation layout, fusion). Explicit user
action keeps the model predictable.

### 10.3 How does the tree present multi-level clustering?

A clustering step today produces `clusterLevels[]` — multiple levels
in one result. Does each level become a separate child tree node? Or
stays as a single step with a multi-level result?

**Lean**: single step, multi-level result. The level array is part
of one clustering's output; splitting them across tree nodes makes
"add another level" awkward.

But: auto-recursion (the deferred §7 Q1/Q3 work) might want per-level
steps so each level can be optimised independently. Worth revisiting
when that slice begins.

### 10.4 What happens to live-mode panels?

Several panels are dual-mode today (live = renders latest
`state.evalResults.optimise`; saved = renders a specific
ValidationRun). In the tree model there's no "latest" — there are
just steps, each with a result. Live mode goes away.

**Lean**: live mode disappears. The panel always binds to a step id.
The "render the latest" use case becomes "render the selected step",
which is the same shape.

### 10.5 How does the user remove dead branches?

If they fork-experiment and want to delete an old branch:

- Per-node delete (with confirm if it has children)?
- Soft-delete (hidden but present)?
- Hard-delete on a "manage tree" surface?

**Lean**: per-node delete with confirm; cascades to children. Soft-
delete is a follow-up feature if users ask.

### 10.6 Project save size

Each step's result can be substantial (Int32Arrays per cluster level,
per-cluster maps, etc.). A user with 50 forked clusterings has 50x
the per-clustering data in the save. Cap? Lazy-load?

**Lean**: no cap initially. Each step's result is stashed in the
existing `arrays/` payload subdirectory of the .zip; deserialise is
already lazy (only revives the referenced TypedArrays). Watch
for pain at the 20+ step mark.

### 10.7 What does "current viewer" mean for a fusion-comparison step?

Selecting a fusion-comparison step has no geometry of its own — it's
a comparison of two upstream clusterings. Does the viewer:

- show nothing (with a hint)?
- show one of the two referenced clusterings (which?)?
- show a side-by-side of both (in viewer-2d as twin scatters)?

**Lean**: shows the "candidate" (the post-fusion side, by
convention), with the comparison panel making the difference
visible. Side-by-side could be a future viewer panel.

---

**Sign-off needed before any Phase-1 code.** Sections 1–3 carry the
load-bearing decisions; the rest is sequencing + open questions.
Once those three are agreed, Phase 1 (modal independence) becomes a
~1-week concrete slice; the rest follows once Phase 1 ships and we
have evidence of how the new shape feels.
