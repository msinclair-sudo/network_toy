# Multi-level clustering + tree scoring + bridge clusters — plan

**Status (2026-05-30): draft for review.** This is a design plan, not
shipped work. It collects the feature request from `pending_changes.md`
(Features §1) into a concrete, phased plan grounded in the existing
machinery. Decisions the user needs to make are flagged **[DECIDE]**.

This addresses the deferred open question **§10.O1** in
`doc/workflow-tree-redesign.md` (how the workflow tree presents
multi-level clustering) and the long-pending scoring re-scope in
`doc/plan.md` §6.18/§6.19.

## 1. Vision (restated from the request)

The user wants to **discover how many resolution layers naturally emerge
from the topology** of the 100-d embedding, then cluster each layer at
its natural granularity and explore the result with a **simple
layer-by-layer scoring** workflow:

- **Highest layer = lowest resolution** — few clusters. For the current
  dataset the user's own exploration puts this at **~8–12 clusters**. A
  *simple test* should determine that range automatically rather than
  the user guessing it.
- **Each lower layer = higher resolution** — more clusters. The number
  of layers is unknown and should be **data-derived**, not fixed.
- For each layer, **search for the optimal clustering settings that land
  the cluster count inside that layer's target range**.
- The highest-resolution layer has many clusters — that's fine, because
  **scoring + labels let the user filter** down to what matters.

And a **re-scoped scoring system** (replacing the old Shiny scoring app,
which "does far too much"):

- The scorer should do *one thing*: **present a cluster's label and ask
  the user to score it 1–5.**
- Scoring is **layer-by-layer**. At the top layer the user scores the
  few coarse clusters. Moving to the next (finer) layer, the labels
  presented are **filtered by the parent layer's scores** via a
  **manipulable threshold** — raise it to see only children of
  high-scored parents, lower it to widen.
- Because the preferred clustering is **global** (not strictly
  hierarchical), a fine cluster can draw members from **two coarse
  parents** — these are **bridge clusters**. They:
  - are shown/hidden by the threshold,
  - carry **multiple parent scores** (displayed for transparency),
  - are ordered by their **highest parent score**,
  - are **sectioned separately** so the user can focus on cleanly
    encapsulated clusters independently of the bridges.

The tree-style workflow is the enabler: the user can score in different
ways (different threshold settings, different parent layers) and keep
each as a branch.

## 2. What already exists (leverage points)

A lot of the machinery is already here — this feature is mostly
*orchestration + a new scoring surface + a bridge panel*, not new
algorithms.

| Need | Exists today | File |
|---|---|---|
| Multi-level partitions | `clusterLevels[]` — array of `{uid, scope, clusterResult}`; `scope` is `"global"` or `"within-parent"` | `app/src/clustering-cascade.js` |
| Search settings for a target cluster-count range | `runTargetRangeSweep()` — Phase-1 Latin-hypercube probe + Phase-2 refine; ranks configs that land in `[targetMin, targetMax]` | `app/src/eval/sweep.js` |
| Optimise UI driving the sweep | Optimise tab (target-range mode, per-row Apply, level picker) | `app/src/ui/modals/clustering-tabs/optimise-tab.js` |
| Multi-parent fine clusters (the bridge primitive) | `bridge-analysis.js` — per fine cluster, share breakdown against **every** coarser level, `spanCount`, `dominantFraction`, `isBridge` | `app/src/ui/bridge-analysis.js` |
| Dim / cluster-count stability signal | `dim-sweep` — per-dimension cluster counts + pairwise ARI heatmap | `app/src/eval/dim-sweep.js` |
| Scorers (numClusters, richness, ARI, stability) | `scorers.js` | `app/src/eval/scorers.js` |
| Workflow-tree cards + branching + saved-mode panels | Phase 2 (shipped) | `doc/workflow-tree-redesign.md` |

**Gaps to build:**

1. **Auto layer-range discovery** — a "simple test" that turns the 100-d
   space into a list of natural cluster-count ranges, one per layer. The
   dim-sweep gives cluster-count-vs-dimension but there's no automated
   "find the plateaus / knees." *(New.)*
2. **Layer cascade driven by discovery** — run `runTargetRangeSweep`
   once per discovered range, coarsest→finest, producing the
   `clusterLevels[]`. *(Mostly orchestration over existing sweep.)*
3. **Minimal tree scoring surface** — a 1–5-per-cluster scorer with
   per-layer threshold propagation. No in-toy equivalent exists; the old
   Shiny scoring app is external and explicitly out of scope. *(New.)*
4. **Bridge-cluster panel** — threshold-filtered, multi-parent-score,
   sectioned display. The *analysis* exists; the *panel* does not. *(New
   panel over existing `bridge-analysis.js` output.)*
5. **Multi-level card shape** in the workflow tree (§10.O1). *(New.)*
6. **Labelling** — there is currently **no cluster labelling at all** in
   the toy (clusters are numeric ids). TF-IDF is a real-data concern;
   see §7. *(New, real-data only.)*

## 3. Layer-range discovery (the "simple test")

Goal: from the 100-d embedding, output an ordered list of target
cluster-count ranges — coarsest first — without the user guessing.

**[DECIDE] Which discovery signal?** Candidates, cheapest first:

- **A. HDBSCAN condensed-tree persistence (recommended).** HDBSCAN
  already builds a condensed cluster tree with per-cluster stability
  (persistence). The number of clusters that survive at increasing
  `min_cluster_size` / persistence thresholds gives a natural ladder of
  resolutions. Read the persistence spectrum once; the "shelves" where
  the surviving-cluster count is stable across a band of thresholds are
  the natural layers. Fits the existing HDBSCAN path; no new dependency.
- **B. Cluster-count plateau from a resolution sweep.** Sweep one
  resolution knob (e.g. `minClusterSize` or `mutualK`) across its range,
  record cluster count, and find the **plateaus** (bands where the count
  barely changes) — each plateau is a natural layer, its count the
  target. Reuses `sweepAcrossAlgorithms` machinery; algorithm-agnostic.
- **C. Dim-sweep cluster-count knee.** Reuse `dim-sweep`'s per-dimension
  cluster counts and look for the stable region. Weakest fit — dim-sweep
  is about *compression dimension* stability, not resolution layers.
- **D. Eigengap / silhouette sweep.** Classic but needs new code and is
  sensitive to metric choice; heavier than A/B.

**Lean: A (HDBSCAN persistence) as the primary signal, B as the
algorithm-agnostic fallback** (mutual-kNN has no persistence tree). Both
output the same contract:

```
discoverLayers(input100d, opts) → [
  { layer: 0, targetRange: [lo, hi], rationale: "persistence shelf @ ..." },
  { layer: 1, targetRange: [lo, hi], ... },   // finer
  ...
]
```

The top layer's range should match the user's empirical ~8–12 for the
current dataset — a useful validation check for whichever signal we pick.

**[DECIDE] Cap on layer count?** Data-derived, but we likely want a sane
ceiling (e.g. ≤ 5 layers) so the scoring workflow stays tractable.

## 4. The layer cascade (orchestration)

Once `discoverLayers` yields N ranges, build `clusterLevels[]` coarsest
→ finest:

```
for each discovered range [lo, hi] (coarse → fine):
    sweep = runTargetRangeSweep({ targetMin: lo, targetMax: hi,
                                  algorithms, scorer: richness, ... })
    pick sweep.ranked[0]            // best in-range config
    infer that config → ClusterResult
    push { uid, scope: "global", clusterResult } onto clusterLevels
```

Notes:
- **Global scope** per the user's stated preference (so fine clusters
  can bridge coarse parents — that's the whole point of §6). We do *not*
  use `within-parent` scope here.
- The scorer for "best in range" is **[DECIDE]** — `clusterRichness`
  (nClusters × macro-Jaccard) is the current real-data default and
  rewards a stable-but-rich partition; `numClusters`-closest-to-midpoint
  is simpler. Recommend richness.
- This is a long-running, multi-stage job → a **workflow card** with a
  queue job (mirrors the dim-sweep / optimise runners). See §6.

## 5. Tree scoring (replace the old scoring app)

A new minimal scoring surface. **One job: show a cluster's label, take a
1–5 score.** Layer-by-layer, with parent-score threshold propagation.

### 5.1 Data model

Scores live on the workflow (so they persist + branch):

```
score = { levelUid, clusterId, value: 1..5, scoredAt }
state.workflow ... scores: { [levelUid]: { [clusterId]: value } }
```

(Exact home **[DECIDE]**: on the multi-level clustering card's result,
or a sibling "scoring" card so the user can keep multiple scorings of the
same clustering as branches. The branch story argues for a **scoring
card** bound to a clustering card via `refIds`.)

### 5.2 Interaction

1. **Top layer first.** Present each coarse cluster: its **label**
   (§7), size, colour swatch, and a 1–5 control. User scores them.
2. **Descend a layer.** Now present the finer clusters, but **filtered
   by a threshold slider** on the parent score: only show fine clusters
   whose dominant parent scored ≥ threshold. Raising the threshold
   narrows to children of the best parents; lowering widens.
3. Each fine cluster shows **which parent(s) it came from and their
   scores** (transparency), so the user understands why it's visible.
4. Repeat down the layers.

### 5.3 Threshold propagation + bridges

- A fine cluster's **parent set** comes straight from
  `bridge-analysis.js` (`perCluster[i].byLevel[parentLevel].shares` →
  the coarse cluster ids it draws members from, with fractions).
- **Encapsulated** fine cluster: one dominant parent (`spanCount === 1`
  or `dominantFraction ≥ τ`). Shown iff that parent's score ≥ threshold.
- **Bridge** fine cluster: `spanCount ≥ 2` (members from 2+ parents).
  - Shown iff **any** parent's score ≥ threshold.
  - Displays **all** parent scores; ordered by the **highest** parent
    score.
  - Rendered in a **separate "Bridges" section** beneath the
    encapsulated clusters, so the two are explored independently.

**[DECIDE] Dominance cutoff τ** for "encapsulated vs bridge" (e.g.
`dominantFraction ≥ 0.7` → encapsulated). `bridge-analysis.js` already
computes `dominantFraction`; we just threshold it.

## 6. Bridge-cluster panel + workflow-tree fit

### 6.1 Bridge panel

A new saved-mode panel rendering `bridge-analysis.js` output for a
selected multi-level clustering, with:
- a parent-level picker + the dominance threshold τ slider,
- two sections: **Encapsulated** and **Bridges**,
- per bridge row: fine id, member count, each parent id + share + parent
  score, sorted by highest parent score.

This is largely a renderer over data that already exists; the new logic
is the threshold filtering + the score join.

### 6.2 Card shape (§10.O1)

Per `doc/workflow-tree-redesign.md` §10.O1 the lean is the **hybrid**:
one **multi-level clustering card** carrying the discovered
`clusterLevels[]`, with **per-layer sub-cards** as children for
layer-specific work (re-optimise a single layer, score a layer). A
**scoring card** binds to the multi-level card; a **bridge card** binds
to it too.

**[DECIDE]** Confirm hybrid vs. one-card-per-level. Hybrid keeps "this
clustering grew to N layers" legible while making per-layer scoring
first-class; it also matches the new per-card `+` add-step UX (UI #2).

## 7. Labelling (TF-IDF and alternatives)

There is **no cluster labelling in the toy today** — clusters are
numeric ids. Labels are a **real-data** concern (papers have
titles/abstracts; the toy's synthetic nodes have none). The user notes
TF-IDF "might not be the best method."

**[DECIDE] Labelling method (real-data only):**
- **TF-IDF over cluster member titles/abstracts** — cheap, interpretable,
  the conventional baseline; weak on multi-word concepts and stopword-ish
  domain terms.
- **c-TF-IDF (class-based, à la BERTopic)** — TF-IDF computed per cluster
  treated as one document; usually crisper topic words than plain TF-IDF.
- **KeyBERT / embedding-centroid nearest terms** — use the SPECTER2
  embedding: label = the title phrases nearest the cluster centroid.
  Reuses the embedding we already have; no bag-of-words.
- **Representative-paper** — just show the paper nearest the centroid as
  the "label." Zero NLP; surprisingly legible.

Recommend shipping **representative-paper + c-TF-IDF keywords** together
(one is a sanity check on the other) and treating richer labelling as
swappable. Labelling should be its **own small module** with a stable
contract `label(clusterMembers) → {keywords[], exemplar}` so the scoring
surface doesn't care which method produced it.

## 8. Phasing

Each phase is independently shippable and testable (pytest + a browser
smoke), mirroring the workflow-tree slices.

- **MLC-1 Layer discovery.** `discoverLayers()` (HDBSCAN persistence +
  resolution-sweep fallback) → ordered target ranges. Pure function +
  tests; validate top range ≈ 8–12 on the current dataset.
- **MLC-2 Layer cascade card.** A multi-level clustering card + runner
  that calls `runTargetRangeSweep` per range and assembles
  `clusterLevels[]`. Hybrid card shape (§6.2).
- **MLC-3 Bridge panel.** Saved-mode panel over `bridge-analysis.js`
  with τ threshold + Encapsulated/Bridges sections.
- **MLC-4 Labelling module.** `label(members)` contract +
  representative-paper + c-TF-IDF; real-data only, guarded.
- **MLC-5 Tree scoring.** Scoring card + 1–5 controls + parent-score
  threshold propagation + bridge transparency. Replaces the old scoring
  app's role inside the toy.

Dependencies: MLC-1 → MLC-2 → {MLC-3, MLC-5}; MLC-4 feeds MLC-5's labels
(scoring can ship with numeric-id placeholders first, then gain labels).

## 9. Open questions (collected)

- **[DECIDE] §3** discovery signal (lean: HDBSCAN persistence + sweep
  fallback) and **layer-count cap**.
- **[DECIDE] §4** per-range "best config" scorer (lean: richness).
- **[DECIDE] §5.1** scores live on the clustering card vs a dedicated
  scoring card (lean: scoring card, for branching).
- **[DECIDE] §5.3** dominance cutoff τ for encapsulated-vs-bridge.
- **[DECIDE] §6.2** confirm hybrid card shape (§10.O1).
- **[DECIDE] §7** labelling method(s) and whether it's in-scope now
  (real-data only).

## 10. Explicitly NOT in this plan

- Re-integrating the external Shiny scoring app (stays separate per
  `doc/plan.md` §1). This plan builds a *minimal in-toy* scorer instead.
- New clustering algorithms — we reuse HDBSCAN / mutual-kNN via the
  existing registry + cascade.
- Changing the global-clustering preference — bridges depend on it.
