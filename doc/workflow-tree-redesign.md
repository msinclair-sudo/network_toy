# Workflow-tree redesign

**Status (2026-05-27):**

- **Phase 1** ✓ shipped — queue.js foundation + Optimise non-blocking
  + auto-save. The original Phase 1 slice C (bottom-bar queued-jobs
  surface) is **dropped** — superseded by per-card overlays in
  Phase 2.
- **Phase 2 slices 2.1 → 2.12 ✓ shipped (all of Phase 2):**
  - **2.1** state.workflow shape + CRUD actions (workflow.js)
  - **2.2** legacy state → tree migration (workflow-migration.js)
  - **2.3** tree-aware workflow-chart renderer
  - **2.4** step↔job binding + spinner + queue-position badge
  - **2.5** modal-as-step-creator (Apply forks a new card)
  - **2.6** re-run affordance on stale cards (↻ button)
  - **2.7** back-compat projection layer (click a card → viewer swaps)
  - **2.8** branching tree layout (multi-card siblings spread
    horizontally with Reingold-Tilford-ish placement)
  - **2.9** bootstrap-stability + dim-sweep + save/load migrated to
    step-bound queue jobs. Each runs from the chart, forks a sibling
    under the right ancestor, panel goes saved-only (§10.D5).
  - **2.11** dead-UX cleanup — `busy.js` + `busy-bar.js` deleted
    (last `enqueueBusy` callers removed in 2.9); 7 disabled topbar
    stubs dropped; entire Validate menu retired (its work lives on
    chart cards now).
  - **2.10** cross-source comparison steps — `fusionComparison`
    generalised to compare any two clustering cards (refIds fan-in,
    dashed chart edges, candidate-geometry projection); runner + saved-
    mode panel + tree picker + modal (2026-05-30).
  - **2.12** next-step affordances — `panels/next-steps.js`, a static
    per-type rule table of follow-on actions that doubles as the
    launcher for net-new analysis cards (2026-05-30).
- **§10.O3 stale visual** resolved by 2.6 (amber dashed border +
  re-run button); **§10.O2 viewer-for-comparison-cards resolved**
  2026-05-30 (show the candidate) during 2.10. Remaining open
  questions: §10.O1 (multi-level clustering shape), §10.O4 (large-save
  strategy) — both deferred, neither blocking.

**Test infrastructure (committed alongside Phase 2 work):**

- `tests/` directory + `pytest.ini` + `conftest.py` with shared
  fixtures (page / toy_page / clean_page). 45+ tests across 9
  modules.
- Default `pytest` ≈ 13 min (BFS-5000 real-data session + slow
  integration tests); `pytest -m "not slow"` ≈ 3 min for fast
  iteration. `slow` marker is on the 4 tests that run real
  HDBSCAN / UMAP at n=5000.
- `scratch/` cleared (was 32 smokes; 5 high/medium-value migrated
  to pytest, the rest dropped — see commit log).

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

Key shape decisions (see §10.D1–D7 for full rationale):

- **DAG, not strict tree.** `refIds` allows fan-in (fusionComparison
  references two cluster cards as ref + cand). The renderer treats
  `parentId` as the primary edge and `refIds` as dashed cross-edges.
- **Cards are unique per result.** Each card is one materialised
  result. Re-running with new params always creates a NEW sibling
  card; the old card stays browsable. Editing a done card's params
  opens its modal pre-populated; Apply creates a new sibling.
- **Immutable once done.** A card transitions pending → running →
  done | failed | cancelled. Done is terminal; the result is never
  mutated. Branch-delete is the only way to remove a done card.
- **Stale is computed.** When an ancestor's result changes (re-run
  produced a new selected sibling, or the user deletes-and-recreates),
  every descendant card is computed as stale. The card stays done —
  its old result still valid as a snapshot — but the renderer shows
  a "upstream changed" warning + offers `re-run` to refresh.
- **Result-revision stamps drive stale detection.** Each card has a
  monotonic `revision` field bumped on every result update; each
  child stores its parent's `revision` at result time as
  `upstreamRevision`. Stale = `parent.revision !== upstreamRevision`.
- **All jobs are cards.** Save / load / engine cascade lanes all
  become cards over Phase 2. The bottom busy-bar disappears once
  migration completes (Slice 2.11). Status overlay on the card is
  the user-visible indicator going forward.

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

`state.workflow.selected` points to one card id. Existing panels +
viewers don't change their read API — they keep reading
`state.dimredResult`, `state.clusterLevels`, `state._basePos`, etc.
What changes is what feeds those slots:

- A back-compat projection layer (Slice 2.7) syncs the legacy slots
  from the selected card's ancestry on every `selectStep()` and on
  every step result-update.
- Selecting a different card walks back up the tree to find the
  most recent ancestor of each result type, materialises the legacy
  slots from that ancestry, and re-publishes state.
- For non-geometric cards (an Optimise card, a fusion-comparison
  card) the viewer reads from the nearest ancestor that produced
  basePos — typically the parent dimred / clustering chain.

This decouples "what's the viewer showing" from "what's the most
recently-mutated state slot". The user can leave the viewer on
clustering-A while running an Optimise on clustering-B's branch.

### 3.5 Stale propagation

A card has two related fields:

- `revision`: monotonic counter; bumped each time `setStepResult`
  is called for this card.
- `upstreamRevision`: stamped at result time, capturing the parent's
  `revision`. Used to compute stale.

A card is **stale** when `parent.revision !== this.upstreamRevision`.
Stale is computed at render time, not stored — so changes
propagate without explicit cascade calls.

When a card's stale flag becomes true:

- The renderer shows a "upstream changed" overlay (per §10.O3 —
  visual to be decided).
- A `re-run` affordance appears on hover; clicking enqueues a fresh
  job with the same params and links the result back to this card
  (in-place bump of `revision` + `upstreamRevision`).
- Or the user can fork: clicking "fork & edit" creates a new sibling
  with editable params.

Stale doesn't auto-cascade further downstream. A clustering card
goes stale when its dimred parent re-runs; the user re-runs the
clustering card; that bump in turn makes the *clustering's*
downstream go stale. Each level requires explicit user action.

### 3.6 Persistence

`state.workflow` rides along in the existing `.zip` save format.
Each card's `result` field carries TypedArrays (per-cluster
nodeCluster arrays, dimred Float32Arrays, etc.) — the existing
deep-walker in `persistence/serialise.js` handles them generically
(no per-step-type bespoke serialiser needed; same machinery already
used for validationRuns).

`validationRuns` stays as the existing slot during the transition.
Phase 2 slice 2.9 (migrate other long-runners) walks the existing
validationRuns and converts each into a card. Eventually
validationRuns becomes a derived view ("all cards of these types")
and the slot is retired.

Schema version bump on the save format the moment `state.workflow`
becomes the canonical store. Older saves load via the migration
helper (Slice 2.2).

## 4. Step types (configuration detail)

(Section 3.3 lists them; this section will fill in per-type config
schemas and runner interfaces during Phase 1. Deferred from this
draft — too speculative without the queue + tree shipped.)

## 5. Queue semantics (mid-flight detail)

(Detailed protocol — what happens on cancel, retry, mid-flight
progress, parallel branches. Deferred until the basic queue lands;
the §6.13 FIFO is the v1.)

## 6. Relationship to existing surfaces

| Existing | Becomes | When |
|---|---|---|
| `state.layerParams.*` | back-compat projection from the selected card's ancestry | Slice 2.7 |
| `state.clusterLevels` / `dimredResult` / `_basePos` / etc. | back-compat projection from the selected card | Slice 2.7 |
| `state.layerStates.*` | per-card `status` field (per-card, not per-layer) | Slice 2.3 (renderer rewrite) |
| `state.validationRuns` | derived view "all cards of types matching" | Slice 2.9 → retired in 2.11 |
| `state.evalResults.optimise` | derived view "latest optimise card's result" | Phased out by Slice 2.9 |
| `state.busy` (legacy bottom-bar slot) | **removed** — cards carry their own status overlay | Slice 2.11 |
| `enqueueBusy` (busy.js) | `enqueueJob` (queue.js) with `stepId` binding | Slices 2.4 + 2.9 |
| `setBusyPhase` | `updateStepProgress(stepId, {phase, fraction})` | Slice 2.4 |
| Workflow chart (`workflow-chart.js`) | tree-aware renderer reading from `state.workflow` | Slice 2.3 → multi-card 2.8 |
| Bottom busy-bar (`busy-bar.js`) | **removed** — superseded by per-card overlays | Slice 2.11 |
| Topbar menus | trimmed; tree operations (export tree, etc.) | Slice 2.11 |
| Modals | step-config forms (Apply creates a new card) | Slice 2.5 |
| Panels | step-result renderers bound to a card id | Slice 2.5 (live mode disappears per §10.D5) |
| Existing layer cards in workflow-chart | become "baseline" cards from migration | Slice 2.2 |

The migration table is staged: each slice can ship independently
without breaking the surfaces below it. The bottom busy-bar +
`busy.js` go away only after every long-runner is migrated (2.9);
until then they continue carrying any legacy callers.

## 7. Phased delivery plan

Three phases. Each is independently shippable; each makes the toy
more useful even if subsequent phases never land.

### Phase 1 — Modal independence (✓ shipped 2026-05-26)

**Done.** The queue.js typed-job foundation (slice A) + Optimise
sweep enqueues + auto-saves (slice B). The Optimise modal no longer
has to stay open. Other long-running modals (bootstrap-stability,
dim-sweep) still use direct calls — slice C migrates them, but that
work was rolled into Phase 2 once the design statement landed
(see below).

The original Phase-1 slice C (a bottom-bar surface for queued jobs)
is **dropped** — once all jobs become cards (§10.D3), there's
nothing left for the bottom bar to show. Skip the intermediate; go
straight to cards.

### Phase 2 — Workflow tree expansion

This is the big shift: the workflow chart becomes the primary
analysis surface. Sub-sliced into focused, shippable pieces below.

Effort estimates are rough; assume each slice = a few days of
focused work + a smoke per affected surface.

#### Slice 2.1 — `state.workflow` shape + step CRUD actions ✓ shipped

State-layer only; no UI yet. Introduce:

```js
state.workflow = {
  steps:    { [id]: Step },
  rootId:   string,
  selected: string,
}
```

Step shape per §3.1 (with the §10.D1–D3 decisions baked in:
immutable-once-done, stale-on-upstream-change, status lifecycle).

Actions: `createStep`, `updateStepStatus`, `setStepResult`,
`deleteStep` (with cascade), `selectStep`, `markDescendantsStale`.

No callers yet; tests are pure state mutations. Out of scope:
migration, renderer, modal wiring.

#### Slice 2.2 — Migration: legacy state → baseline tree ✓ shipped

When a project loads (or on first boot) without `state.workflow`
populated, reconstruct a baseline tree from existing slots:

  - **Always**: `data → dimred → clustering`. These are the
    universal analysis spine for both toy and real data; every
    project has them.
  - **Toy-mode only**: `citations → layout → alignment → blend`
    branch off clustering. These are the taste-network simulation
    output and only exist in toy mode (or when the user has
    explicitly imported citation edges in real mode). The
    migration helper adds these cards only when the corresponding
    result slots are populated.
  - **Validation runs** (Optimise sweeps, bootstrap-stability,
    dim-sweeps, fusion-comparisons that the user saved) get
    attached as children of the relevant ancestor (e.g. a
    `type: "optimise"` ValidationRun attaches under the clustering
    card it was scored against, identified by
    `inputs.layerParamsSnapshot.clustering`).

Each migrated card carries the existing result + `status: "done"`.
The active path's leaf (typically the clustering card) becomes
`selected`. Old saved projects load via the existing schema-version
path; the deserialiser invokes the migration helper.

Pure helper; tested via "load a v2 .zip, verify tree shape" plus
"toy boot → clustering-and-blend present; real boot → no blend".

#### Slice 2.3 — Workflow-chart renderer rewrite ✓ shipped

Replace the hand-positioned 7-node SVG with a tree-aware renderer.
First cut renders the baseline linear tree from 2.2 — visually
identical to today's chart for unmigrated projects, but reading
from `state.workflow` instead of the hard-coded `NODES` list.

Click → `selectStep(id)`. Status dots driven by step status, not
the legacy `state.layerStates`.

Smoke: chart renders correctly on boot + after migration + after
state mutation.

#### Slice 2.4 — Step ↔ job binding + spinner/position overlay ✓ shipped

queue.js's `enqueueJob` gains a `stepId` opt. When a job is bound
to a step, the step's status mirrors the job's status; the
workflow-chart renders a spinner overlay on the step's card while
the job runs and a position badge while pending.

Optimise (shipped slice B) gets retrofitted: each Run creates a
new clustering child card AND enqueues a job bound to it. The
spinner appears on the new card; the old card stays done +
unchanged.

This is where "each card is unique" goes live.

#### Slice 2.5 — Modal-as-step-creator ✓ shipped

Every modal's Apply creates a new step (forks from the currently-
selected step's parent or appends as child, depending on the step
type's semantics). No more direct mutation of `state.layerParams`
or `state.dimredResult` etc.

Modals touched: data-source-modal, dimred-modal, clustering-modal
(Configure tab), algorithm-modal (citation layout).

The legacy "current path" slots become read-only projections from
the selected step — listeners that read `state.dimredResult` keep
working without rewriting them (Slice 2.7 handles the back-compat
layer).

Smoke: each modal applied creates a new tree card; old result
intact; new result attached.

#### Slice 2.6 — Stale propagation ✓ shipped

When a card's params or result changes (whether by re-run or by a
new sibling becoming "selected"), descendants get marked stale.
Visual warning per §10.O3.

`re-run to refresh` affordance on each stale card.

Smoke: change a dimred card's params → corresponding clustering
descendant goes stale → clicking re-run produces a new clustering
card whose status is fresh.

#### Slice 2.7 — Back-compat projection layer ✓ shipped

Existing panels + viewers read from singular slots
(`state.dimredResult`, `state.clusterLevels`, `state._basePos`,
etc.). These become *read-only projections* from
`state.workflow.steps[state.workflow.selected]` (and its ancestors).

Concretely: a `syncSelectionProjections()` helper, called by
`selectStep` and after any step's result lands, populates the
legacy slots from the active path. Nothing in the panels needs to
change — they keep reading state.dimredResult; the underlying data
is now selection-driven.

Smoke: select different clustering cards → viewer-3d / node-table
/ all panels reflect the selection without modifications.

#### Slice 2.8 — Multi-card per layer (real branching UI) ✓ shipped

Today's chart layout is hand-positioned for 7 nodes. Once 2.5
lands, users can create unlimited siblings — the renderer needs
to lay them out automatically.

Pick a layout strategy: hierarchical (top-down, siblings spread
horizontally) is the obvious default. Add pan / zoom / collapse
controls.

Smoke: create 3 dimred siblings → chart renders all three
side-by-side; selecting each shows its result.

#### Slice 2.9 — Migrate other long-runners to step-bound jobs ✓ shipped

Bootstrap-stability + dim-sweep + save / load all became cards via
2.5's pattern. Each creates a new card and binds a queue.js job.

Sub-slices:
- **2.9.a** Bootstrap — new `bootstrap-modal.js` + `runners/bootstrap-
  runner.js`; panel goes saved-mode-only (auto-binds to the latest
  done card or a legacy validationRun). Parent = selected clustering
  ancestor.
- **2.9.b** Dim-sweep — same shape, new `dim-sweep-modal.js` +
  `runners/dim-sweep-runner.js`. Modal exposes dims/seeds/threshold
  only; algos pinned to the §6.9 validation-script defaults. Parent
  = selected dimred ancestor.
- **2.9.c** Save/load — `topbar.js` save + load + `data-source-
  modal.js` apply + `validation-run-optimise` apply-row all migrated
  off `enqueueBusy` onto `enqueueJob`. Save + load create cards
  under the root; the others piggy-back on existing step-bound jobs
  via descriptor.applyChange. Zero `enqueueBusy` callers remain.
- **2.9.d** pytest coverage (`tests/test_slice_2_9_step_bindings.py`)
  + structural-invariant test that no module imports `enqueueBusy`.

Once this slice landed, the bottom busy-bar had no live consumers;
slice 2.11 retired it.

#### Slice 2.10 — Cross-source steps (fusion-comparison + future)

`fusionComparison` becomes the canonical pairwise comparison
renderer for any two cluster cards — not just pre/post-fusion.
Step config picks ref + cand source cards via the tree picker.
`refIds` wired through.

Same pattern unblocks "compare two algorithm choices on the same
data" — a future cross-algorithm card.

**Scoping (2026-05-30).** The comparison engine is already
source-agnostic: `compareFusionPartitions(refCr, candCr, …)` in
`app/src/eval/fusion-compare.js` takes two arbitrary `ClusterResult`s
(ARI / NMI / macro-Jaccard / per-cluster best-match / top movers). The
pre/post-fusion framing lives only in `panels/fusion-comparison.js`,
which hard-reads `state.clusterLevels` + `state.clusterLevelsPreFusion`.
So 2.10 is mostly plumbing two user-chosen cards into a function that
already works — not new analysis. `createStep` already supports +
validates `refIds` (`workflow.js`); acyclicity is moot because refIds
are set only at create-time on a childless node, which can't close a
cycle.

Locked decisions:

- **Parent edge** = the currently-*selected* card (via
  `findSelectedAncestorOfType`, same as the bootstrap / dim-sweep
  analysis cards). Both source clusterings come in as `refIds`, not
  `parentId`.
- **Viewer** = show the *candidate* clustering's geometry (§10.O2,
  now resolved). Because `parentId` isn't a geometry ancestor, the
  slice-2.7 projection layer needs a `fusionComparison` special-case
  that projects from the **candidate refId's** ancestry.

Sub-slices (mirror the 2.9 modal+runner pattern):

- **2.10.a** `runners/fusion-comparison-runner.js`
  (`buildFusionComparisonJob({refStepId, candStepId})`, snapshots both
  cards' cluster results per level → `result.comparison`) + refactor
  the panel to render saved-mode from `step.result` (live mode retires
  per §10.D5). Projection special-case for the candidate viewer.
- **2.10.b** `step-tree-picker.js` (reusable; clustering cards with
  lineage labels, non-clustering greyed out) + `fusion-comparison-
  modal.js` (ref + cand pickers, validate distinct + both clustering)
  + `fusionComparisonDescriptor()` in `layer-descriptors.js`, registered
  in `getLayerDescriptor` + `DESCRIPTOR_BY_TYPE`. Start with a flat
  lineage-labelled `<select>` before a full tree widget.
- **2.10.c** Render `refIds` as dashed cross-edges in
  `workflow-chart.js` (§10.D4 — solid `parentId`, dashed `refIds`) +
  CSS.
- **2.10.d** `tests/test_fusion_comparison.py` + extend
  `test_workflow.py`: comparison card with two real clustering cards as
  refIds → runner populates `result` → chart draws dashed edges →
  stale propagates when a ref card is re-run.

#### Slice 2.11 — Dead-UX cleanup + bottom-bar removal ✓ shipped

Sub-slices:
- **2.11.a** Deleted `busy.js` + `busy-bar.js`. Removed the
  `#busy-bar` element + its CSS, `state.busy` slot, `mirrorToBusy`
  in queue.js, and the 5 `setBusyPhase` calls in engine.js.
  `mountBusyBar` import + call in main.js gone.
- **2.11.b** Trimmed disabled topbar stubs. 7 items dropped (real-
  dataset loader, label/edge export, presets, ARI dim-sweep menu,
  disagreement, method manual, keyboard shortcuts). Entire Validate
  menu removed since both items were subsumed by chart cards
  (dim-sweep) or deferred (disagreement metric).
- (No 2.11.c "restructure menus around tree operations" — the
  menus that remain are small enough that a restructure is
  premature; we have File / Data / Workflow / Help and that's it
  now. Re-evaluate when 2.12's "what's next" surface lands.)

#### Slice 2.12 — Next-step affordances ✓ shipped

Per-card "what's next?" panel (`panels/next-steps.js`) subscribing to
the selected step. A **static rule table per step type** (no ML-driven
suggestions, no compute-time estimation) maps `step.type` → valid
follow-on actions; each button opens the relevant layer-descriptor
modal (or `rerunStep` for analysis cards). e.g. a clustering card
offers bootstrap stability, compare-with-another-clustering, dim sweep,
and citation layout.

This panel doubles as the **discoverable launcher for net-new analysis
cards** (bootstrap / dim-sweep / fusion-comparison) — before 2.12 those
were only reachable via migration of legacy validationRuns or by
clicking an already-existing card.

Registered in `panels/registry.js` (picker-added, singleton). Tests in
`tests/test_next_steps.py`.

### Dependency graph

```
2.1 ✓ ─▶ 2.2 ✓ ─▶ 2.3 ✓ ─▶ 2.4 ✓ ─▶ 2.5 ✓ ──┬─▶ 2.6 ✓
                                              ├─▶ 2.7 ✓ ─▶ 2.8 ✓ ─▶ 2.10 ✓
                                              └─▶ 2.9 ✓ ─▶ 2.11 ✓ ─▶ 2.12 ✓
```

All Phase 2 slices shipped (2.1 → 2.12). The workflow-tree redesign is
feature-complete; remaining items are the deferred open questions
(§10.O1 multi-level clustering, §10.O4 large-save strategy).

## 8. Migration / back-compat

Old saved projects load. The deserialiser detects whether
`state.workflow` is present:

- **Present**: use as-is.
- **Absent**: reconstruct from `state.layerParams` + existing result
  slots per Slice 2.2's rules:
  - Always emit `data → dimred → clustering` (the universal spine).
  - Add the `citations → layout → alignment → blend` branch only
    when the corresponding result slots are populated — i.e. toy
    mode or real mode with imported citations.
  - `validationRuns` get reattached to their nearest matching
    ancestor by `inputs.layerParamsSnapshot` heuristic.

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

## 10. Design decisions

### Locked (2026-05-26)

#### 10.D1 Cards are unique per result (immutable once done)

Each card represents one materialised result. Re-running with new
params creates a **new card**, never overwrites a done one. This
keeps the history browsable and means a saved project carries
every analysis the user ran on it.

The flow:
- Pending → Running → Done | Failed | Cancelled.
- Done is terminal. Editing a done card's params opens its modal
  pre-populated, and Apply creates a sibling card with the new
  params (same parent).
- The user can explicitly Delete a card; deletion cascades to
  descendants and removes their saved results.

Implications:
- "Run the same algorithm twice with the same params" produces two
  cards (sibling duplicates). Cheap; nothing breaks; user can delete
  one.
- "Re-run after upstream changed" = create a new card (the old one
  is stale; see 10.D2).
- Today's `clusterLevels` slot becomes a projection from the
  *selected* clustering card; switching cards in the tree switches
  the viewer's projection.

#### 10.D2 Stale propagation: downstream cards warn when upstream changes

When a card produces a new result (whether by re-running in place or
because a new sibling was added that shifts the "selected" path),
every downstream card that depended on the prior result gets marked
**stale**. The card stays done — its old result is still valid as a
snapshot — but the renderer shows a visual warning ("upstream
changed") and offers a one-click "re-run to refresh" affordance.

No auto-cascade. The user decides whether to re-run, because:
- Auto-cascade has been the source of several historical UX bugs
  (citation layout, fusion).
- The user may want to inspect the old result alongside the new
  upstream before deciding.

Stale is a computed property: each render walks the tree and asks
"does this card's `result.upstreamRevision` equal its parent's
`result.revision`?" — when they differ, stale=true.

#### 10.D3 All jobs are cards

Every long-running operation becomes a card in the tree, not a
bottom-bar job. This includes:
- Engine-cascade lanes (reingest, redimred, recluster, etc.) —
  each lane becomes a card or a sub-step of a card.
- Save / load — a "Save project to disk" card, a "Load project
  from disk" card. The user sees them in their history.
- Optimise sweeps, bootstrap stability, dim sweep, fusion comparison
  — already framed as cards in §3.3.

The bottom busy bar disappears once migration completes. The card's
status overlay (spinner + queue position) is the user-visible
indicator going forward.

This is more invasive than the original §3.3 list — but it follows
naturally from "the tree is the workflow". A separate bottom-bar
surface would mean two places to look for in-flight work.

#### 10.D4 DAG, not strict tree

`refIds` allows fan-in (fusionComparison references two clusterings).
The tree renderer treats `parentId` as the primary edge (drawn
solid), `refIds` as cross-edges (drawn dashed). Cycles forbidden;
enforced at refIds-add time.

#### 10.D5 Live-mode panels disappear

Several panels are dual-mode today (live = reads latest
`state.evalResults.optimise`; saved = renders a specific
ValidationRun). In the tree model there is no "latest" — there are
just cards, each with a result. The panel always binds to a card id.

#### 10.D6 Branch deletion cascades

Per-card delete with confirm. Removing a card removes its result
AND every descendant card's result. The user gets a confirm dialog
listing what'll be deleted.

#### 10.D7 No save-size cap initially

Each card's result can be substantial (Int32Arrays per cluster level,
per-cluster maps, etc.). No cap on save size; the existing zip
+ binary-payload format handles arbitrary blob counts. Watch for
pain at the 50+ card mark; revisit then.

### Still open

#### 10.O1 How does the tree present multi-level clustering?

A clustering step today produces `clusterLevels[]` — multiple levels
in one result. Three candidates:

- **Single card, multi-level result** — one card carries the whole
  `clusterLevels[]` array. Simple. But making each level
  individually optimisable requires per-level state inside the card.
- **One card per level** — chain of clustering cards, each
  producing one level. Maps naturally to per-level optimise. But
  "add another level" becomes "add a child" — UI ceremony.
- **One card with sub-cards for additional levels** — hybrid: card
  wraps level 0; additional levels are child cards under it. Lets
  the user see "this clustering grew to 3 levels" while keeping
  per-level work first-class.

**Lean**: hybrid (the third option). Aligns with the deferred
auto-recursion work (§7 of plan.md Q1/Q3) — each recursion step is
naturally a new child card.

Decide when the auto-recursion slice gets queued for actual work.

#### 10.O2 What does "current viewer" mean for a fusion-comparison step? ✓ resolved 2026-05-30

**Resolved (slice 2.10 scoping).** Show the **candidate** clustering's
geometry; the fusion-comparison panel carries the actual diff. Because
a comparison card's `parentId` is the *selected* card (not a geometry
ancestor), the slice-2.7 projection layer needs a `fusionComparison`
special-case: project geometry from the **candidate refId's** ancestry,
not the parent chain. Side-by-side twin scatters in viewer-2d remain a
possible future viewer panel, not part of 2.10.

#### 10.O3 What's the visual for "stale upstream"? ✓ resolved 2026-05-27

**Resolved by slice 2.6.** Stale cards get an amber dashed border
(`.wf-node-rect.stale` already shipped with slice 2.3) plus a small
amber ↻ "re-run" button in the top-right corner. Click forks a new
sibling under the current canonical parent via `rerunStep(stepId)`
in `layer-descriptors.js`, which dispatches to the matching
descriptor's `applyChange` with the stale step's stored params.

#### 10.O4 Stash strategy when the project is large

If a project has 50+ cards each carrying TypedArray results, the
save zip could balloon. Options:

- Lazy-rehydrate (already done): only revive when read.
- Compress per-card.
- Garbage-collect cancelled/failed cards on save.
- Cap settled-card retention.

Defer until pain appears.

---

**Sign-off status (2026-05-30):** §1–3 architecture + §10.D1–D7
decisions locked. Phase 1 + **all of Phase 2 (slices 2.1 → 2.12)
shipped** — the workflow-tree redesign is feature-complete. §10.O2 + O3
resolved; the only remaining open questions (§10.O1 multi-level
clustering shape, §10.O4 large-save strategy) are deferred-until-pain
and don't block anything.
