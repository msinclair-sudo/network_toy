# Data ingest — how the toy reads data in (current state)

Reference for wiring the **SQLite data source** next session. Describes the
Layer-1 contract every data source must satisfy, exactly what the current
`real` source loads and from where, what each downstream consumer needs,
and the one real gap (**per-node text**) that blocks c-TF-IDF / TF-IDF
labelling. The embedding stays a **separate** artifact (not in the db) —
this doc assumes that split.

---

## 1. The Layer-1 output contract

`app/src/datasource/contract.js` — every source's `produce(params)` returns:

```
{
  nodes: [{
    id:        int,            // MUST be contiguous 0..n-1, id === array index
    t:         number ∈ [0,1], // publication-year normalised (newest→1, oldest→0)
    originId?: int | null,     // toy ground-truth label; null for real
    basePos?:  [x,y,z],        // optional per-node viz position (toy supplies; real omits)
    year?:     int | null,     // real adds this (not validated by the contract)
    paperId?:  string | null,  // real adds this (external paper id; not validated)
  }],
  origins?:   [{id, centre, spread, colour}],   // toy ground-truth mixture; null for real
  embedding?: { d:int, data: Float32Array(n*d) },// high-dim feature vectors per node
  basePos?:   Float32Array(n*3),                 // optional flat viz buffer
  method?:    string,                            // source id echoed back
  params?:    object,                            // echo of resolved params
}
```

**Hard rules** (validated, `validateDataSourceResult`):
- `nodes` non-empty; `nodes[i].id === i`; `nodes[i].t` finite.
- `embedding.data.length === n*d`; `basePos.length === n*3` when present.
- At least one of **per-node basePos**, **flat basePos**, or **embedding**
  must exist (else Layer 1.5 has nothing to reduce).
- `year` / `paperId` / any other per-node field are **passed through
  untouched** — the contract doesn't validate them, downstream consumers
  read them opportunistically. **This is where new fields (title, authors,
  venue, …) get added: just put them on the node object.**

Registration: one entry in `app/src/datasource/registry.js`
`DATA_SOURCES[]` — `{ id, label, description, defaultParams, produce,
modalSchema }`. Adding the SQLite source = one new entry; no consumer
changes for the contract fields.

---

## 2. What the `real` source loads today

`app/src/datasource/real.js` → `produceReal(params)`. Files live under
`/literture-network/artifacts/<subset>/` (the static server is rooted at
the repo root, so they resolve alongside `/app/`). Per subset:

| File | Format | Purpose | Optional? |
|---|---|---|---|
| `expanded_embeddings.npy` | NumPy `<f4`, shape `(n, 768)` | the SPECTER2 embedding | **required** |
| `expanded_embeddings_paper_index.json` | `{ "<i>": "<paperId>" }` | node index → external paper id | **required** |
| `paper_years.json` | `{ "<i>": <year> }` | per-node publication year | optional (404 → `t=0`, `year=null`) |
| `citation_edges.json` | `{ edges: [[src,dst],…], meta }` | citation edges | optional (404 → no fusion/layout) |

Notes:
- The `.npy` is parsed by a hand-rolled reader (`parseNpy`) — only `<f4`
  dtype, 2-D shape. Embedding is the one artifact that stays a **file**,
  separate from the db.
- `t` is computed by min–max normalising `year` across the subset.
- **Citation edge direction**: on disk it's citgraphv2's "source is *cited
  by* target"; the toy contract is the reverse ("source cites target").
  Layer 3 (`citations/`) flips on materialisation. Fusion's symmetric
  diffusion doesn't care, so `real.js` passes edges through as-stored,
  flattened to `[src,dst,src,dst,…]` in `result.citationEdges`.

`produceReal` returns nodes as `{ id, t, year, paperId }` + `embedding
{d:768,data}` + `citationEdges` (flat). **No basePos** — the viewer stays
empty until Layer 1.5's viz sub-stage fits a 3-D reduction.

---

## 3. Engine ingest → state slots

`app/src/ui/engine.js` → `ingestDataOnly()` packs the source result into
the legacy state slots (`update({...})`):

| State slot | From | Consumed by |
|---|---|---|
| `state.genResult` | the whole source result (incl. `nodes`) | everything — `nodes[i].year`, `.paperId`, `.t` |
| `state.embedding` | `result.embedding` | dim-reduction (L1.5); labelling `representative` |
| `state.rawCitationEdges` | `result.citationEdges` (flat) | fusion (graph-diffusion), citation layout (L3/L4) |
| `state._basePos` | packed per-node basePos (toy) / `null` (real) | viewer; blend |

---

## 4. Who needs what (map the db schema against this)

| Consumer | Field needed | Source today | Status |
|---|---|---|---|
| Dim-reduction (L1.5) | `embedding {d,data}` | `.npy` | ✅ separate file |
| Fusion / citation layout (L3/L4) | `rawCitationEdges` | `citation_edges.json` | ✅ |
| FR time anchor `t` | `nodes[i].t` (from year) | `paper_years.json` | ✅ |
| Labelling · **year** | `nodes[i].year` | `paper_years.json` | ✅ |
| Labelling · **representative** | `embedding` + `nodes[i].paperId` | `.npy` + index | ✅ (returns a paperId, not a title) |
| Labelling · **c-TF-IDF / TF-IDF** | **`ctx.getText(nodeId) → string`** | — | ❌ **not materialised** |
| (mentioned, not yet consumed) | authors, venue, title display | — | ❌ |

### The text gap (the reason for this whole exercise)

`app/src/labelling/cluster-labels.js` expects a per-node text accessor on
its ctx: `getText: (nodeId) => string | null`. The two places that build
that ctx **both hard-code `getText: undefined`**:
- `app/src/ui/runners/cluster-labels-runner.js` (the labelling card's job)
- `app/src/ui/panels/cluster-scoring.js` (`levelsAndCtx()`)

So `cTfidf` / `tfidf` report `available:false` with reason *"needs per-node
text — titles/abstracts are not materialised in this dataset"* and are
disabled in the labelling modal. Representative-paper currently surfaces a
**paperId**, not a human title, for the same reason.

---

## 5. What the SQLite source must deliver

A new `datasource/sqlite.js` (registered in `registry.js`) whose
`produce(params)` returns the **same contract shape**, with:

1. **Required contract fields** — `nodes[i] = {id (0..n-1), t, year,
   paperId}` and `citationEdges` (flat `[src,dst,…]`), exactly as `real`
   does. (Embedding stays the separate `.npy`; the db just needs to agree
   on node ordering / index ↔ paperId so the embedding rows line up.)
2. **Per-node text** — enough to power `getText`. Two viable shapes:
   - put `title` (and/or `abstract`) directly on each node object
     (`nodes[i].title`), **and/or**
   - return a `getText(nodeId)` / a `nodeText: string[]` on the result.
   Then wire the two ctx builders (§4) to use it instead of `undefined`.
   That single change unlocks c-TF-IDF / TF-IDF labelling and lets
   representative-paper show a real title.
3. **Authors / venue** — carry on the node object too if we want them for
   labelling/display later (contract passes unknown fields through).

**Open questions to resolve against the actual db next session:**
- How is the db delivered to a static-served ES-module app — `sql.js`
  (WASM, read the `.sqlite` over fetch) vs a small local query endpoint?
  (No server code today; everything is static `fetch`.)
- Node **index ↔ paperId** contract: the embedding `.npy` row order must
  match `nodes[i].id`. The db must expose the same ordering (or a stable
  paperId→row map) so embedding and metadata stay aligned.
- Table/column names for: paper (id, year, title, abstract, authors,
  venue) and citation edges (src, dst, direction convention).

---

*Companion: `doc/dynamics.md` (layer index), `doc/plan.md` (§9 multi-level
clustering, analysis-layer cards). Current sources: `datasource/toy.js`,
`datasource/real.js`. Contract + validator: `datasource/contract.js`.*
