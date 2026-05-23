# Resuming dev/dag-workers

> Branch parked 2026-05-21. Postmortem written 2026-05-23 after diagnosing
> the user-visible bugs that pushed us back to `main` for a demo. Read
> this before touching the worker code.

## What this branch shipped

Three slices of §6.11 (Web Worker port for heavy compute lanes):

- **Slice 1 — runner + DAG + dimred worker.** `app/src/workers/{worker-runner.js, dag.js, dimred-worker.js}`. `redimred()` rewritten as `async`, builds a small DAG (noise → fusion → {compression, viz, viz2d}, plus optional pre-fusion sibling pair), awaits `runDAG`. Sibling lanes parallelise via `Promise.all` batches inside the walker.
- **Slice 2 — clustering worker.** `app/src/workers/clustering-worker.js` + `app/src/clustering-cascade.js` (shared multi-level cascade extracted from `engine.js` so the worker can reuse it). `recluster()` async; DAG has `post` always + optional `pre` when `dimredResultPreFusion` exists.
- **Slice 3 — layout worker.** `app/src/workers/layout-worker.js`. `relayoutCitations()` async, single-node DAG (uniform shape with the other lanes).

Plus a defensive fix in `blend/blend.js` to keep the fusion-comparison slider working when no citation layout has been applied. Plus full-URL esm.sh imports in `dimred/umap.js` and `citation-layout/umap-graph.js` so workers can resolve them without an importmap.

Smoke tests live under `scratch/`. All passed at toy n=400; HDBSCAN + fusion verified end-to-end at BFS n=5000.

## Why we parked it

User had a demo in 3 hours and reported two showstoppers on this branch:

1. **Fusion slider stopped moving the viewer.**
2. **Clustering modal "closed instantly, nothing really happened."**

Both reverted to `main` (then `9c9e026` + two demo fixes) which became the new live main. This branch is parked until we triage and re-merge.

## What actually broke (headless trace, 2026-05-23)

I drove the user's exact BFS-5000 + HDBSCAN path headlessly on this branch (`scratch/dag_bfs_modal_repro.py`). The trace tells a clear story:

```
applyChange kicked off at t=0
  t=    50ms: rev=4, nClusters=555, method=mutualKNN, layer=fresh
  t=  5000ms: rev=4, nClusters=555, method=mutualKNN, layer=fresh
  t= 15000ms: rev=4, nClusters=129, method=hdbscan,   layer=fresh   ← HDBSCAN landed
```

The workers ran correctly for 15 seconds and updated state. **rev never bumped. layer never went to "running".** Neither the viewer nor the workflow chart noticed.

### Bug 1: `recluster()` doesn't bump `engineRevision`

`engineRevision` is the signal viewer-3d's `update(s)` reads to decide whether to call `rebuildData()` + `colourOverlay.refreshOptions()`. Without the bump, the viewer sees `dataChanged === false` → no rebuild → no colour update → no dropdown refresh. The clustering DID change underneath (mutualKNN→hdbscan, 555→129 clusters), but the viewer kept painting the old result.

This is the same regression `main` carries — fixed there in commit `2d5fb4a` with a one-line addition to `recluster()`'s `update({...})` block. **The dev/dag-workers refactor accidentally dropped that bump when restructuring `recluster()` around `runDAG`.** Easy to re-add post-rebase; the line is the same.

### Bug 2: no `setLayerState("clustering", "running")` at the start of `recluster()`

`recluster()` calls `setLayerState("clustering", "fresh")` at the END, but never sets "running" at the START. So for the full 15 seconds the worker is running, the workflow chart's clustering node stays green. **There's literally no UI signal outside the modal that work is happening.**

Same gap exists in `redimred()` and `relayoutCitations()` — they all only mark "fresh" at the end, never "running" at the start.

Pre-DAG this gap was hidden by the page freezing visibly during the 18-second compute. The freeze was the user's "something is happening" signal. Workers fixed the responsiveness but exposed the missing progress indicator.

### "Modal closed instantly"

Headless tests show the modal correctly stays open ~15s on BFS+HDBSCAN. The mechanics (`startProgress()` + `setTimeout(async, 30)` + `return false` + manual `modalHandle.close()` after await) work as designed. The most likely real explanations:

- **Browser cache**: user's session loaded the OLD `clustering-modal.js` from before the Running…-pattern fix landed.
- **Combined with bugs 1+2**: even if the modal stayed open ~15s and then closed, the viewer never repainted, so the user's takeaway was "nothing happened". The modal-closing felt instantaneous in retrospect because it correlated with no visual change.

Not chasing this further until we can repro live post-rebase.

### What WASN'T broken

- The worker mechanism itself. Workers spawned, ran, posted back, results landed in state. No deadlocks, no silent failures, no orphan workers (verified across multiple smoke runs).
- Compute correctness. HDBSCAN at BFS-5000 produced 129 clusters in ~18s, byte-identical to the synchronous pre-DAG result.
- The DAG architecture. `runDAG` + sibling parallelism gave the expected speedups (~3× on the post-fusion sibling triple at BFS scale).
- The fusion slider's BLEND HOOK. `blend/blend.js` was fixed identically on both branches.

## What to do when resuming

In rough order:

### 1. Rebase onto main first

```bash
git checkout dev/dag-workers
git rebase main
```

Main has two commits this branch doesn't:
- `2d5fb4a` fix: fusion slider + multi-level cluster dropdown refresh
- `a1892e9` chore: gitignore saves/

The blend.js part of `2d5fb4a` will collide with this branch's own version of the same fix (which is functionally identical — comment wording differs). Take main's version. The engine.js part of `2d5fb4a` should land cleanly into this branch's restructured `recluster()` — it just adds the `engineRevision: s.engineRevision + 1` line inside the existing `update({...})` call.

### 2. Add `setLayerState("X", "running")` at the start of each async lane

```js
export async function recluster() {
  // ... initial state reads ...
  setLayerState("clustering", "running");
  // ... DAG build + await runDAG ...
  // existing setLayerState("clustering", "fresh") at the end stays
}
```

Same shape for `redimred()` (`setLayerState("dimred", "running")` at the start) and `relayoutCitations()` (`setLayerState("layout", "running")`). The workflow chart's status dots already render "running" as orange — they just never saw the signal.

### 3. Verify with `scratch/dag_bfs_modal_repro.py`

The repro script in this branch's `scratch/` should now show `layer=running` during the worker phase and `rev` bumping at completion. If it does, the user-visible bugs are addressed.

### 4. Open question (for a later slice): Optimise → Validate hop is fire-and-forget

`clustering-modal.js`'s `onApplyRow` path:

```js
setActiveTab("validate");
Promise.resolve(descriptor.applyChange(row.algoId, levels)).catch(...);  // not awaited
```

The user clicks an Optimise sweep row → instantly lands on Validate tab → but the new clustering hasn't applied yet. Validate reads stale clusters. Either gate Validate's Run button on `layerStates.clustering === "fresh"`, or show a Running indicator on the Validate tab while the apply is in flight. Real race, not just a UX nit. Defer until after the rebase + indicator fixes are validated.

### 5. Cost note (informational, not a fix)

At toy n=400, the DAG path is ~80ms vs ~50ms sync. Workers don't pay off at toy scale — they only matter once compute reaches the threshold where main-thread freeze hurts (~n=1000 in practice). Documented in §6.11 of `doc/plan.md`. Don't optimise; just be aware that demos on toy will feel slightly slower than the main-branch sync path.

## File map (so you don't have to grep)

**New on this branch:**
- `app/src/workers/worker-runner.js` — generic `runInWorker(workerUrl, payload, {signal, transferList}?)`.
- `app/src/workers/dag.js` — `runDAG(dag, {signal}?)`, topo-sorts + parallel-batches.
- `app/src/workers/dimred-worker.js` — module worker entry, dispatches on `algo` (identity/pca/umap/graph-diffusion).
- `app/src/workers/clustering-worker.js` — module worker entry, runs full multi-level cascade per job.
- `app/src/workers/layout-worker.js` — module worker entry for FR / MDS / UMAP-on-graph.
- `app/src/clustering-cascade.js` — `runClusterLevels` + `clusterWithinParents` + `sliceDimred` + `slimNodesForClustering`. Extracted from `engine.js` so the worker can import them.

**Modified on this branch:**
- `app/src/ui/engine.js` — `redimred()`, `recluster()`, `relayoutCitations()` all async + DAG-based. Worker URLs at top. `runClusterLevels` etc. removed (moved to `clustering-cascade.js`).
- `app/src/dimred/umap.js`, `app/src/citation-layout/umap-graph.js` — full URL imports for worker compatibility.
- `app/src/ui/modals/clustering-modal.js`, `app/src/ui/modals/algorithm-modal.js` — `Running…` button + setTimeout-await-close pattern.
- `app/src/ui/modals/layer-descriptors.js` — descriptor `applyChange` functions are now `async` + `await` their engine lane.
- `app/src/blend/blend.js` — fusion slider works when `alignedCitationLayout` is null.
- `doc/plan.md` — §6.11 locked decisions; §6.12 deferred; §6.14/§6.15/§6.16 cleanups.

**Diagnostic scripts** (under `scratch/`, force-added since `scratch/` is gitignored):
- `worker_slice1_smoke.py`, `worker_slice3_smoke.py` — boot + worker spawn checks.
- `bfs_cluster_test.py`, `hdbscan_bfs_test.py` — BFS-5000 lane tests.
- `multilevel_check.py` — multi-level + HDBSCAN at toy.
- `fusion_*.py` — fusion path probes (toggle, no-citation-layout blend, slider interactivity).
- `modal_stays_open.py`, `cluster_modal_drive.py` — interactive modal repros.
- `dag_modal_repro.py`, `dag_bfs_modal_repro.py` — the load-bearing traces that diagnosed bugs 1 + 2 above.