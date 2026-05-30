# Multi-level clustering + tree scoring + bridge clusters — plan

**Status (2026-05-30): decisions incorporated — ready to slice.** This is
a design plan, not shipped work. It collects the feature request from
`pending_changes.md` (Features §1) into a concrete, phased plan grounded
in the existing machinery. The user's decisions (originally flagged
**[DECIDE]**, answered inline as **[USER]**) are now folded into each
section as **Decided**.

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

**Decided: HDBSCAN — and extract ALL layers from a single stored run's
hierarchy, not from repeated range-sweeps** (per [USER] below). One good
HDBSCAN run already builds a condensed cluster tree; the layers are
*cuts* of that one tree at different stability levels. This is far more
elegant (and cheaper) than running `runTargetRangeSweep` once per layer.
It becomes a new **"Optimise multi-layer"** mode in the Optimise modal;
the existing modes (single-config, target-range, full sweep) stay as-is.
See §4 for how the single-run extraction works and the **one caveat**:
the toy's HDBSCAN result must expose the condensed-tree / per-λ cluster
counts (today it stores flat labels + per-cluster `stability`; we likely
need to surface the condensed tree from the worker).

> [USER] note answering "is the full sweep the same results?": a *full
> sweep* is many independent flat partitions at different params — useful
> as a fallback source of "what cluster counts are achievable," but it is
> **not** the same as one run's hierarchy. The elegant path is the single
> run's condensed tree; the stored sweep is a Plan-B input for the
> algorithm-agnostic fallback (§3.B).

The candidate signals considered (cheapest first):

**[USER] i agree that HDBSCAN is a good choice here**. using these results we can maybe also avoid having to use teh range optimisation. if we do one good soil run of HDBSCAN and store resutls (we alerady do this) we can simply find the layers from that. this is much more elegant than running range optisation runs over and over again. we'll include this in the optimize modal, when optimize multilayers is selected this is the apraoch. the other options can remain as they are. for intance is the full sweep is used. thoes stored results can techinally be used for the multilayerd part. it's teh same results isn't it?

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

**Decided: cap = 5 layers.** Data-derived count, hard-capped at 5 — more
than that and the scoring workflow becomes bloated.

**[USER] 5 is a good sounding cap.** any larger and it becomes bloated and un nessacery.

## 4. The layer cascade (single-run extraction)

**Decided (§3): extract the layers from ONE HDBSCAN run's condensed
tree** — no per-layer range-sweep. The condensed tree is already a
hierarchy; each layer is a horizontal cut at a different stability (λ)
level, yielding progressively finer partitions.

```
run = runHDBSCANWithTree(input100d)        // one run; emits condensed tree
counts = clusterCountAtEachLambdaCut(run)  // how many survive vs λ
shelves = stablePlateaus(counts, capLayers = 5)   // the natural layers
for each shelf (coarse → fine):
    partition = flattenTreeAtLambda(run, shelf.lambda)   // global labels
    push { uid, scope: "global", clusterResult: partition } onto clusterLevels
```

Notes:

- **Global scope** (so fine clusters can bridge coarse parents — the
  whole point of §6). We do *not* use `within-parent` scope; the cuts are
  of the same global tree, so a fine cluster can straddle two coarse
  ones naturally.
- **No per-range scorer needed** for the HDBSCAN path — the tree gives
  the partitions directly. (The old [DECIDE] "best-in-range scorer" only
  applies to the §3.B algorithm-agnostic *fallback*, where richness
  remains the recommended ranker.)
- **Caveat / prerequisite:** the toy's HDBSCAN currently stores flat
  labels + per-cluster `stability` but not the full condensed tree.
  MLC-1/MLC-2 must surface the condensed tree (parent/λ/child) from the
  HDBSCAN worker so the cuts can be computed. This is the main new
  engine work; everything downstream is orchestration.
- This is a long-running job → a **workflow card** with a queue job
  (mirrors the dim-sweep / optimise runners). See §6.

## 5. Tree scoring (replace the old scoring app)

A new minimal scoring surface. **One job: show a cluster's label, take a
1–5 score.** Layer-by-layer, with parent-score threshold propagation.

### 5.1 Data model

Scores live on the workflow (so they persist + branch):

```
score = { levelUid, clusterId, value: 1..5, scoredAt }
state.workflow ... scores: { [levelUid]: { [clusterId]: value } }
```

**Decided: a dedicated "scoring" card** bound to the multi-level
clustering card via `refIds`, so the user can keep multiple scorings of
the same clustering as separate branches (the tree-branch story the user
wants). Scores are not stored on the clustering card itself.

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

**Decided: dominance cutoff τ defaults to 0.8, adjustable in the scoring
modal.** A fine cluster with `dominantFraction ≥ 0.8` is *encapsulated*;
below that it's a *bridge*. `bridge-analysis.js` already computes
`dominantFraction`; we threshold it, and expose τ as a slider so the
user can tighten/loosen the encapsulated-vs-bridge split live.

**[USER] agree on using threshold** set the defult to 0.8, with the threshold changable within the scoring modal.

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

**Decided: hybrid card shape** (one multi-level clustering card +
per-layer sub-cards; scoring + bridge cards bind via `refIds`). Keeps
"this clustering grew to N layers" legible while making per-layer work
first-class, and matches the per-card `+` add-step UX (UI #2). Note the
viewer already has a **colour-by-layer** mode, so visualising the
clusters at any level is already supported — selecting a layer sub-card
(or a scoring threshold) just drives which level the viewer colours by.

**[USER] agree** we have the colour by layer in the veiwer anyway, so if the user wants to visulize the clusters at lower levels and surface that data we already have that included.

## 7. Labelling (TF-IDF and alternatives)

There is **no cluster labelling in the toy today** — clusters are
numeric ids. Labels are a **real-data** concern (papers have
titles/abstracts; the toy's synthetic nodes have none). The user notes
TF-IDF "might not be the best method."

**Decided: labelling is its own module that can run MULTIPLE methods and
combine/compare them** (real-data only). KeyBERT is the preferred method,
but all of them are worth shipping — computing several and showing them
side-by-side adds defensibility: for a cluster that's interesting or
hard to score, the user compares the different methods' labels. The
module contract returns labels per method so the scoring surface can
show one or many:

```
label(clusterMembers) → { byMethod: { keyBERT: {...}, cTfidf: {...},
                                      tfidf: {...}, exemplar: {...} },
                          combined: {...} }
```

**[USER] agree on this being it's own module**, i favour the keyBERT method, but shiping, each of these method is a good choice, and being able to combine the labels will add in defensability. for example we decide to compute all of the methods, and we cherry pick some clusters that are of interest or we're having troubling score and compare the differnt labels.

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

Per the decision above, ship **KeyBERT (preferred) + c-TF-IDF +
representative-paper** behind the one module, computed together so the
scoring surface can show/compare them. Plain TF-IDF is the cheap
baseline. The module stays swappable — adding a method is one registry
entry, like the clustering / scorer registries.

## 8. Phasing

Each phase is independently shippable and testable (pytest + a browser
smoke), mirroring the workflow-tree slices.

- **MLC-0 Surface the HDBSCAN condensed tree.** Extend the HDBSCAN
  worker/result to emit the condensed tree (parent / λ / child / size)
  alongside the flat labels. Prerequisite for single-run extraction
  (§4 caveat). Pure-ish engine work + tests.
- **MLC-1 Layer discovery.** `discoverLayers()` reads MLC-0's tree,
  finds the stable λ-shelves (cap 5), returns ordered layer cuts.
  Algorithm-agnostic fallback (§3.B) for mutual-kNN reuses the stored
  sweep. Validate top range ≈ 8–12 on the current dataset.
- **MLC-2 Layer cascade card + Optimise modal mode.** A multi-level
  clustering card + runner that flattens the tree at each discovered
  λ-cut into `clusterLevels[]`. Add the "Optimise multi-layer" mode to
  the Optimise modal (other modes unchanged). Hybrid card shape (§6.2).
- **MLC-3 Bridge panel.** Saved-mode panel over `bridge-analysis.js`
  with τ=0.8 threshold (adjustable) + Encapsulated/Bridges sections.
- **MLC-4 Labelling module.** Multi-method `label(members)` (KeyBERT +
  c-TF-IDF + representative-paper); real-data only, guarded.
- **MLC-5 Tree scoring.** Scoring card (refIds-bound) + 1–5 controls +
  parent-score threshold propagation + bridge transparency. Replaces the
  old scoring app's role inside the toy.

Dependencies: MLC-0 → MLC-1 → MLC-2 → {MLC-3, MLC-5}; MLC-4 feeds MLC-5's
labels (scoring can ship with numeric-id / exemplar placeholders first,
then gain richer labels).

## 9. Decisions (resolved)

All originally-open points are now decided (per the user's inline
answers):

- **§3 discovery signal** → HDBSCAN, extracting layers from a single
  run's condensed tree (not repeated range-sweeps); algorithm-agnostic
  sweep-plateau fallback for non-HDBSCAN. **Layer cap = 5.**
- **§4 cascade** → flatten one HDBSCAN tree at each λ-shelf; no per-range
  scorer for the HDBSCAN path (richness only for the fallback).
- **§5.1 scores home** → a dedicated scoring card bound via `refIds`
  (enables multiple scorings as branches).
- **§5.3 dominance cutoff τ** → default 0.8, adjustable in the scoring
  modal.
- **§6.2 card shape** → hybrid (multi-level card + per-layer sub-cards);
  viewer reuses the existing colour-by-layer mode.
- **§7 labelling** → its own multi-method module (KeyBERT preferred,
  plus c-TF-IDF + representative-paper), computed together and
  comparable; real-data only.

Remaining genuinely-open item: **the condensed-tree surfacing (MLC-0)** —
confirm the HDBSCAN worker can expose the tree without a heavy rewrite
before committing to single-run extraction. That's the first thing to
prototype.

## 10. Explicitly NOT in this plan

- Re-integrating the external Shiny scoring app (stays separate per
  `doc/plan.md` §1). This plan builds a *minimal in-toy* scorer instead.
- New clustering algorithms — we reuse HDBSCAN / mutual-kNN via the
  existing registry + cascade.
- Changing the global-clustering preference — bridges depend on it.
