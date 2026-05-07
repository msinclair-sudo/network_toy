# Clustering layer — contract and algorithms

This document is the source of truth for how the clustering layer is
shaped, what every algorithm must produce, and how downstream code
interacts with it. Algorithms come and go; the contract should not.

If you are about to add or modify a clustering algorithm, the rule is:

1. The algorithm produces a `ClusterResult` object that satisfies the
   contract in §1.
2. `validateClusterResult` (`app/src/contracts/cluster.js`) accepts the
   result without throwing.
3. Downstream consumers (`citations.js`, `citation-taste.js`,
   `neighbourhoods.js`, `clustering-debug.js`, `main.js`) keep working
   without changes.

If any of those three conditions can't be met, the contract changes
and this document is updated *first*, then code follows.

---

## 1. The `ClusterResult` contract

Every clustering algorithm must return an object of this shape.

```ts
{
  method:    string,                  // algorithm id, e.g. "mutualKNN" / "hdbscan"
  params:    object,                  // params the algorithm actually ran with,
                                       //   after clamping / normalisation
  clusters: [
    {
      id:        int,                 // 0..numNormalClusters-1, OR -1 for noise
      centre:    [x, y, z],           // numeric 3-tuple, centroid of member basePos
      spread:    number,              // RMS distance of members from centre
      count:     int,                 // number of members (matches nodeCluster)
      colour:    string,              // hex string, "#RRGGBB"
      stability: number,              // ALWAYS present. NaN for algorithms that
                                       //   do not compute stability.
    },
    ...
  ],
  nodeCluster:    Int32Array,         // length n. nodeCluster[i] = cluster id of node i.
                                       //   Either in [0, numNormalClusters) or -1.
  structureEdges: [[i, j], ...],      // algorithm-specific debug edges:
                                       //   - mutualKNN → mutual k-NN edges
                                       //   - hdbscan   → MST edges
                                       //   Always undirected, always with i < j.
}
```

### Optional fields

- **`noiseFlags`** (optional, `Uint8Array(n)`) — per-node flag, 1 if the
  node was classified as noise by the algorithm before any absorption,
  0 otherwise. Algorithms that have no noise concept omit this entirely.
  This is independent of `nodeCluster[i]`: a node may have
  `noiseFlags[i] === 1` (was-noise) but `nodeCluster[i] === 2` (absorbed
  into cluster 2). Used by debug overlays so the user can see the
  algorithm's pre-absorption decisions.

### Field-by-field

- **`method`** — string id matching an entry in the algorithm registry.
  Used by the UI to know which params modal to open and by debug
  overlays to know what `structureEdges` *means*.

- **`params`** — the actual params after clamping. May differ from the
  user's input if e.g. K was clamped to `n - 1`. Consumers should read
  these for display ("running with k=8 (clamped from 12)").

- **`clusters`** — array of cluster metadata. Order:
  - Normal clusters first, in id order: index `c` has `id === c` for
    `c ∈ [0, numNormalClusters)`.
  - Noise pseudo-cluster (if any) last, with `id === -1`.

- **`clusters[c].id`** — contiguous from 0 for normal clusters. The
  noise entry, if present, has `id === -1`.

- **`clusters[c].centre`** — `[x, y, z]` numeric 3-tuple. Centroid of
  the member basePos coordinates. For the noise pseudo-cluster this is
  still computed over its members (or `[0, 0, 0]` if zero members; the
  contract treats this as a valid edge case).

- **`clusters[c].spread`** — RMS distance of members from `centre`.
  Recommended definition; not enforced — consumers only display it.

- **`clusters[c].count`** — number of members. Must satisfy
  `count === |{i : nodeCluster[i] === id}|` (the validator checks this).

- **`clusters[c].colour`** — hex string. Convention: normal clusters use
  `TABLEAU10[id mod 10]`. Noise uses a fixed grey (`#7a8090`).

- **`clusters[c].stability`** — ALWAYS present. `NaN` for algorithms
  that don't compute it. Consumers must guard with `Number.isFinite`
  before using.

- **`nodeCluster`** — `Int32Array` of length `n`. Every value is either
  in `[0, numNormalClusters)` (normal cluster) or `-1` (noise).
  `-1` is only allowed if the validator was called with
  `{ allowNoise: true }`.

- **`structureEdges`** — array of `[i, j]` pairs of node ids, always
  with `0 ≤ i < j < n`. Algorithm-specific meaning:
  - `mutualKNN` — pairs that mutually appear in each other's top-K.
  - `hdbscan`   — edges of the mutual-reachability MST.
  Used only by the clustering debug overlay; not a downstream
  dependency.

### Optional-field invariants

If `noiseFlags` is present, the validator checks:
- `noiseFlags instanceof Uint8Array`
- `noiseFlags.length === n`
- every entry is 0 or 1

### Invariants the validator checks

1. `result` is an object with all required top-level fields.
2. `clusters.length` matches the number of distinct cluster ids in
   `nodeCluster`, plus 1 if any `-1` appears.
3. `nodeCluster` has length `n`. Every value is either in
   `[0, numNormalClusters)` or `-1`.
4. `-1` in `nodeCluster` requires `allowNoise: true`.
5. For every normal cluster `c`, `clusters[c].id === c`.
6. If a noise cluster exists, it is the last entry of `clusters[]` and
   has `id === -1`.
7. For every cluster `c` (normal or noise),
   `clusters[c].count === |{i : nodeCluster[i] === clusters[c].id}|`.
8. `clusters[c].centre` is a 3-tuple of finite numbers (`[0,0,0]` is OK
   for empty / noise clusters).
9. `clusters[c].colour` matches `/^#[0-9a-fA-F]{6}$/`.
10. `clusters[c].stability` is present (may be `NaN`).
11. Every `structureEdges[k]` is a `[i, j]` with
    `Number.isInteger(i)`, `Number.isInteger(j)`, `0 ≤ i < j < n`.

### Invariants the contract deliberately does NOT enforce

- The *order* clusters appear in beyond "id `c` at index `c`, noise
  last." Algorithms may renumber however they like.
- *How* `spread` is computed.
- The *colour palette* (consumers display whatever the algorithm
  emits; only the format is checked).
- The *count* of `structureEdges` (algorithms with no debug-edge
  concept may emit `[]`; consumers must accept that).

---

## 2. Where this contract is consumed

Every consumer is listed here so that any future contract change can
be checked against the full impact surface.

### `app/src/citations.js`

- Reads `clusterResult.nodeCluster[i]` to decide intra vs cross.
- Treats `nodeCluster[i] === -1` (noise) by — **TBD when noise lands.
  Likely: each noise node is its own singleton from citations'
  perspective.**

### `app/src/citation-taste.js`

- Reads `clusterResult.clusters.length` and
  `clusterResult.clusters[c].centre`.
- Iterates `clusters[c]` for `c ∈ [0, length)`. Currently assumes all
  entries are valid clusters.
- **TBD when noise lands**: must skip the noise entry (id = -1) when
  building cluster taste, since neighbourhoods of "noise" don't have a
  meaningful taste set.

### `app/src/neighbourhoods.js`

- Reads `clusterResult.clusters.length` and
  `clusterResult.nodeCluster[i]`.
- Currently buckets nodes by cluster id, then runs mutual k-NN per
  bucket.
- **TBD when noise lands**: noise nodes either become their own
  singleton neighbourhood or are skipped entirely.

### `app/src/clustering-debug.js`

- Reads `clusterResult.clusters` (for centroid markers).
- Reads `clusterResult.structureEdges` (was `mutualEdges`) for the
  edge overlay.

### `app/src/main.js`

- Reads `clusterResult.clusters[c]` for legend (`.colour`, `.count`,
  `.spread`, plus `.stability` when present).
- Reads `clusterResult.nodeCluster[i]` for colour-by-cluster.
- Reads `clusterResult.method` to drive the Cluster ▾ menu state and
  decide which modal to open.

---

## 3. Algorithm registry

Every clustering algorithm registers itself in
`app/src/clustering-registry.js` with this shape:

```ts
{
  id:    string,                    // matches the `method` in ClusterResult
  label: string,                    // user-facing label for Cluster ▾ menu
  defaultParams: () => object,      // factory; returns fresh defaults
  infer:         (genResult, params) => ClusterResult,
  allowsNoise:   boolean,           // does the algorithm produce -1 ids?
  modalSchema:   ParamSchema[],     // declarative description of the modal UI
                                     //   (so we don't hand-write a modal per algo)
}
```

`modalSchema` is a list of one entry per parameter. Schema entry shape:

```ts
{
  key:    string,                   // matches a key in defaultParams()
  label:  string,                   // user-facing label
  kind:   "range" | "int",          // (we'll add more if needed)
  min:    number,
  max:    number,
  step:   number,
  format: (value) => string,        // for the value badge
  hint?:  string,                   // optional one-line description
}
```

This means **adding a new algorithm = registry entry only**. The Cluster ▾
menu and the modal are generated from the registry.

---

## 4. Currently-registered algorithms

### 4.1 Mutual k-NN

- `id: "mutualKNN"`
- `allowsNoise: false`
- Params: `{ mutualK: int }` (default 5)
- Output:
  - `nodeCluster[i]` always ≥ 0; never -1.
  - `structureEdges` = the mutual-k-NN edges that defined the
    components.
  - `stability` = `NaN` for every cluster.
- Algorithm: see §2 of `dynamics.md`. Top-K nearest neighbours by
  basePos, edge exists iff mutual, connected components.

**Known limitation.** Halo nodes — points sitting in the periphery of
a dense cluster — can end up as singleton components even though they
are geometrically clearly part of the cluster. This happens because the
core nodes' top-K all point at each other inside the core, never out at
the halo, so the halo's proposed edges go unreciprocated. This is the
"trap" that motivated adding HDBSCAN (§4.2). The trade-off is real:
mutual k-NN refuses to chain narrow bridges between dense regions, at
the cost of being conservative about the periphery.

### 4.2 HDBSCAN — to be added in stages

- `id: "hdbscan"`
- `allowsNoise: true`
- Params: `{ minSamples: int, minClusterSize: int }`
- Output:
  - `nodeCluster[i]` may be `-1` for noise.
  - `structureEdges` = the mutual-reachability MST edges.
  - `stability` = the EOM-extracted stability score per cluster.
    `NaN` for the noise pseudo-cluster.
- Algorithm: see §3 of this document (to be filled in when the
  algorithm lands).

---

## 5. Pipeline rerun semantics

The clustering layer sits between generation and neighbourhoods. Any
change to `state.clusterParams.method` OR to a clustering-modal slider
triggers `recluster()`, which:

1. Calls the active algorithm's `infer(genResult, params)`.
2. Validates the result against the contract.
3. Updates `state.clusterResult` and the cluster legend.
4. Cascades downstream: `reneighbour() → retaste() → resample()`.
5. Reheats the simulation so the new pair table takes visible effect.

Switching algorithms re-runs the full clustering chain but **does not**
reset live node positions or the citation seed. The user can compare
algorithms on the same dataset by toggling the Cluster ▾ menu.

---

## 6. Versioning the contract

If we ever need to break the contract, the steps are:

1. Update §1 of this document with the new contract.
2. Bump the contract version (add a `CLUSTER_CONTRACT_VERSION`
   constant in `app/src/contracts/cluster.js`).
3. Update `validateClusterResult` to enforce the new invariants.
4. Run every registered algorithm and update its `infer` to satisfy
   the new contract.
5. Update each consumer in §2 to read the new fields.
6. Update the changelog at the bottom of this section.

### Changelog

- **v1 (2026-05-07)** — initial contract. Renamed `mutualEdges` →
  `structureEdges`. Added optional `stability` (always present, may be
  NaN). Allowed `nodeCluster[i] === -1` for noise when
  `allowNoise: true`.
- **v1.1 (2026-05-07)** — added optional `noiseFlags: Uint8Array(n)`
  for algorithms that classify points as noise. Independent of
  `nodeCluster[i]`: a point may be both flagged as noise AND assigned
  to a cluster (when the algorithm uses soft absorption to fold noise
  into the nearest stable cluster). Mutual-k-NN omits this field;
  HDBSCAN always populates it.
