# Fusion fork — pre/post-fusion as forked workflow branches

**Status: SHIPPED 2026-06-01 (Phase A) → 2026-06-01 (Phase B).** This file
is kept as historical design context. The dual-track was removed in commit
`ce2de16`; the pre/post fork + cross-branch comparison cards landed in
`9f228c3` (Phase A) and `ed21f7c` (cross-branch). Live behaviour is now
documented in `cards.md` (palette) and `doc/plan.md` §8 + §10 (rationale).

---

(Original plan below for historical reference.)

Replaces the current automatic
dual-track (clusterLevels + clusterLevelsPreFusion in one clustering card).

## Why

Today, when fusion (graph-diffusion) runs, the dim-reduction lane produces
TWO embeddings — `dimredResult` (post-fusion) and `dimredResultPreFusion` —
and the clustering lane silently clusters BOTH, stashing the pre-fusion ladder
in `clusterLevelsPreFusion`. Pre/post is a hidden parallel track inside single
cards.

The user wants pre/post to be an **explicit fork**: after dim-reduction (when
fusion ran), the workflow splits into two branches — a **pre-fusion** branch
and a **post-fusion** branch — each carrying its own embedding downstream
through normal clustering/analysis cards. Later, **comparison cards** take data
ACROSS the two branches (cluster-topology agreement, per-node pre→post
displacement). So the two branches must be cleanly identifiable as a pair.

## Decisions (from the user)

- **Auto-fork into two branches.** When fusion ran, automatically create both a
  pre-fusion card and a post-fusion card under the dim-reduction card; the user
  works in whichever. No manual "pick one" modal.
- **Fork replaces dual-track.** Drop the automatic pre+post clustering and
  `clusterLevelsPreFusion`; downstream cards operate on the ONE embedding their
  branch carries. (clusterPre:N colour mode + the dual recluster pass go away.)
- **Only when fusion ran.** With identity fusion there's one embedding — no
  fork (the dimred card's child is clustering directly, as today).
- **Sets up cross-branch comparison cards** (next feature): topology agreement +
  node displacement, referencing the two branches via the existing
  `refIds: [a, b]` pattern (as fusionComparison already does).

## The fork card

A new card type **`fusionBranch`** (one per endpoint). Each carries
`params.endpoint ∈ {"pre","post"}` and projects the matching embedding into the
legacy `state.dimredResult` slot that all downstream cards read:

- post → `state.dimredResult = <post embedding>`, `_basePos = <post basePos>`
- pre  → `state.dimredResult = <pre embedding>`,  `_basePos = <pre basePos>`

So a clustering card under the pre branch clusters the pre-fusion embedding,
under the post branch the post-fusion embedding — using the SAME existing
clustering code, no per-card pre/post branching. The projection layer
(`workflow-projection.js`) gets a `projectFusionBranch` that swaps the right
embedding into the read slots when a fusionBranch (or any descendant) is
selected.

### Where the embeddings live

The dimred card already stores both on its result (or we stash them):
`dimredResult` (post) + `dimredResultPreFusion` (pre), `_basePos` +
`_basePosPreFusion`, `_basePos2d` (+ pre 2d if needed). The fusionBranch
projector reads the dimred ancestor's result and routes the chosen endpoint.

## Data-flow changes

1. **`redimred`** keeps producing both embeddings when fusion is active (no
   change there) — but stores them on the dimred CARD result so the branches
   can route from the card, not just transient state.
2. **`recluster` / `recomputeMultiLevelSweep`** stop running the pre pass.
   They read `state.dimredResult` (whatever the active branch projected) and
   produce ONE ladder. Delete the `clusterLevelsPreFusion` writes + the second
   DAG node (engine.js ~660–717).
3. **Auto-fork:** when the dimred card completes AND fusion ran, the dimred
   descriptor's applyChange (on the job promise) auto-creates two fusionBranch
   children (pre, post) and selects the post one (the default).
4. **next-steps:** `dimred` → fusionBranch is implicit (auto-spawned). The
   fusionBranch card offers the normal clustering follow-ons (it's the
   embedding carrier). With identity fusion, dimred → clustering directly (no
   fork).

## Colour modes

`clusterPre:N` colour mode is removed (no parallel pre ladder in one card).
Pre vs post is now "select the other branch card" — the viewer follows the
selected branch's clusterLevels.

## Cross-branch comparison cards (NEXT feature, not this PR)

Once the two branches exist, comparison cards reference them via
`refIds: [preBranchId, postBranchId]`:
- **Topology agreement** — compareFusionPartitions (already exists) on the two
  branches' clusterLevels: ARI/NMI/movers per level.
- **Node displacement** — per-node ‖postBasePos[i] − preBasePos[i]‖ after
  global alignment (alignGlobal already used in redimred); ranks papers whose
  citation context moved them most. Needs both branches' aligned basePos.
This plan SETS UP those by giving the branches stable ids + carried embeddings;
the comparison cards are a follow-up.

## Files touched

| File | Change |
|---|---|
| `ui/modals/layer-descriptors.js` | new `fusionBranchDescriptor` + switch case; dimred descriptor auto-spawns pre+post branches when fusion ran. |
| `ui/runners/` (new) | `fusion-branch-runner.js` — trivial prep job (the branch is a router; projection does the work). |
| `ui/engine.js` | redimred stashes both embeddings on the dimred card result; recluster + recomputeMultiLevelSweep drop the pre pass + clusterLevelsPreFusion. |
| `ui/workflow-projection.js` | `projectFusionBranch` swaps the chosen endpoint into dimredResult/_basePos; dimred projector carries both embeddings on the card result. |
| `ui/next-steps-rules.js` | fusionBranch offers clustering/multiLevel follow-ons; dimred's child is the fork (auto). |
| `ui/viewer-shared/colour-modes.js` | remove clusterPre:N mode. |
| `ui/panel-system.js` | (maybe) auto-open nothing for fusionBranch — it's a router, not a result panel. |
| persistence | branches are workflow cards (not persisted as a slot); committed clusterLevels still save. Confirm no clusterLevelsPreFusion consumers break. |
| tests | update fusion-comparison / projection / multilevel tests that assume clusterLevelsPreFusion; add fork tests. |

## Open questions for review

1. **Default branch:** auto-select the **post**-fusion branch after the fork
   (post is the "fused" result the toy is named for)? Or pre?
2. **Identity-fusion case:** confirm NO fork when fusion is identity (dimred →
   clustering directly). A fork with one real endpoint is noise.
3. **Existing saves** with `clusterLevelsPreFusion`: a deserialise shim drops
   it silently, or we keep read-compat? (It's derived, so dropping is safe.)
4. **clusterPre colour mode removal:** OK to delete, or keep as a no-op alias
   for old saved configs?
