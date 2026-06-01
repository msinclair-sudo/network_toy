// Real-data source backed by a biblion SQLite corpus (built by tools/ingest/).
//
// Unlike real.js (a pile of JSON/npy files), this source reads a single
// `corpus.sqlite` snapshot in the browser via sql.js (WASM) and queries it on
// demand. The high-dim embedding stays a separate `.npy` (injected exactly like
// real.js). The build pipeline is tools/ingest/{extract_corpus,embed_specter2}.
//
// The one hard invariant (enforced below): embeddings.npy row i ==
// paper_index["i"] == the i-th row of the canonical node-set query against the
// snapshot. We re-run that query here and FAIL LOUD if the db has drifted from
// the embedding (e.g. the db was re-enriched without re-embedding).
//
// Files are served from the repo root by the static server, so /data/... and
// /app/ resolve as siblings. sql.js itself comes from the importmap; its WASM
// binary is fetched from esm.sh via locateFile.

import initSqlJs from "sql.js";
import { parseNpy } from "./npy.js";

// Canonical node-set filter + order. MUST match tools/ingest/corpus_query.py —
// the snapshot, the .npy and this query all have to agree on the node set.
const NODE_SET_WHERE =
  "is_rejected = 0 AND is_stub = 0 AND title IS NOT NULL AND abstract IS NOT NULL";

const DATASETS = {
  // id → {label, sqlitePath, embeddingsPath, indexPath}. Paths are absolute
  // fetch URLs (static server rooted at the repo root).
  biblion: {
    label: "biblion test corpus",
    sqlitePath: "/data/biblion/corpus.sqlite",
    embeddingsPath: "/data/biblion/embeddings.npy",
    indexPath: "/data/biblion/paper_index.json",
  },
};

export const DATASET_IDS = Object.keys(DATASETS);
export const DATASET_LABELS = Object.fromEntries(
  Object.entries(DATASETS).map(([id, ds]) => [id, ds.label])
);

export const defaultSqliteParams = () => ({ dataset: "biblion" });

export const sqliteModalSchema = {
  fields: [
    {
      key: "dataset",
      label: "Dataset",
      type: "select",
      options: DATASET_IDS.map((id) => ({ value: id, label: DATASETS[id].label })),
    },
  ],
};

// sql.js engine — initialised once, shared across produce() calls.
let _sqlPromise = null;
function getSQL() {
  if (!_sqlPromise) {
    _sqlPromise = initSqlJs({
      locateFile: (f) => `https://esm.sh/sql.js@1.10.3/dist/${f}`,
    });
  }
  return _sqlPromise;
}

// Live handle for on-demand per-node lookups (getNodeText). Set by the most
// recent produceSqlite(); replaced when a different dataset is loaded.
let _handle = null;

export async function produceSqlite(params = {}) {
  const datasetId = params.dataset || "biblion";
  const ds = DATASETS[datasetId];
  if (!ds) throw new Error(`[datasource:sqlite] unknown dataset "${datasetId}"`);

  const [SQL, embAb, dbAb, indexObj] = await Promise.all([
    getSQL(),
    fetch(ds.embeddingsPath).then((r) => {
      if (!r.ok) throw new Error(`[datasource:sqlite] ${ds.embeddingsPath}: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(ds.sqlitePath).then((r) => {
      if (!r.ok) throw new Error(`[datasource:sqlite] ${ds.sqlitePath}: HTTP ${r.status}`);
      return r.arrayBuffer();
    }),
    fetch(ds.indexPath).then((r) => {
      if (!r.ok) throw new Error(`[datasource:sqlite] ${ds.indexPath}: HTTP ${r.status}`);
      return r.json();
    }),
  ]);

  const { shape, data } = parseNpy(embAb);
  const [n, d] = shape;

  // index["i"] → papers.id; defines the canonical node order (the .npy contract)
  const idByRow = new Array(n);
  for (let i = 0; i < n; i++) {
    const id = indexObj[String(i)];
    if (id == null) throw new Error(`[datasource:sqlite] paper_index missing row ${i}`);
    idByRow[i] = id;
  }
  if (Object.keys(indexObj).length !== n) {
    throw new Error(`[datasource:sqlite] paper_index has ${Object.keys(indexObj).length} entries, embedding has ${n} rows`);
  }

  const db = new SQL.Database(new Uint8Array(dbAb));

  // Re-derive the node set from the snapshot, in the same order, and verify it
  // matches the embedding's index row-for-row.
  const nodeRes = db.exec(`SELECT id, year FROM papers WHERE ${NODE_SET_WHERE} ORDER BY id`);
  const rows = nodeRes.length ? nodeRes[0].values : [];
  if (rows.length !== n) {
    throw new Error(`[datasource:sqlite] node-set size ${rows.length} != embedding rows ${n} (db drifted from embedding — re-run tools/ingest)`);
  }

  // Year range → t ∈ [0,1] (newest = 1), matching real.js's FR time anchor.
  let yrMin = Infinity, yrMax = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = rows[i][1];
    if (Number.isFinite(y)) {
      if (y < yrMin) yrMin = y;
      if (y > yrMax) yrMax = y;
    }
  }
  const yrRange = yrMax > yrMin ? yrMax - yrMin : 0;

  const rowById = new Map();
  const nodes = new Array(n);
  for (let i = 0; i < n; i++) {
    const id = rows[i][0];
    const y = rows[i][1];
    if (id !== idByRow[i]) {
      throw new Error(`[datasource:sqlite] row ${i}: snapshot id ${id} != paper_index ${idByRow[i]} (embedding/db drift — re-run tools/ingest)`);
    }
    rowById.set(id, i);
    let t = 0, year = null;
    if (Number.isFinite(y)) {
      year = y;
      t = yrRange > 0 ? (y - yrMin) / yrRange : 0;
    }
    nodes[i] = { id: i, t, year, paperId: id };
  }

  // Citation edges → flat [src, dst, …] in node-index space. biblion stores
  // canonical citing→cited, which already IS the toy's "source cites target",
  // so NO direction flip. Drop edges whose endpoint fell outside the node set
  // (the abstract filter can exclude a paper that citations still references).
  const edgeRes = db.exec("SELECT citing_id, cited_id FROM citations");
  const edgeVals = edgeRes.length ? edgeRes[0].values : [];
  const citationEdges = [];
  let droppedEdges = 0;
  for (let k = 0; k < edgeVals.length; k++) {
    const s = rowById.get(edgeVals[k][0]);
    const t = rowById.get(edgeVals[k][1]);
    if (s === undefined || t === undefined) { droppedEdges++; continue; }
    citationEdges.push(s, t);
  }

  // Keep the db open for on-demand getNodeText(). Free any previous handle.
  if (_handle && _handle.db && _handle.db !== db) {
    try { _handle.db.close(); } catch { /* ignore */ }
  }
  _handle = { dataset: datasetId, db, idByRow, textStmt: null };

  return {
    method: "sqlite",
    params: {
      dataset: datasetId,
      yearRange: Number.isFinite(yrMin) ? [yrMin, yrMax] : null,
      edgesKept: citationEdges.length / 2,
      edgesDropped: droppedEdges,
    },
    nodes,
    embedding: { d, data },
    citationEdges,
    // No basePos — Layer 1.5's viz sub-stage populates _basePos on demand.
  };
}

// On-demand per-node text for the labelling ctx (c-TF-IDF / TF-IDF).
// Returns "title. abstract" (whichever are present) for the node's papers.id,
// or null if no corpus is loaded / the row is missing. Reuses one prepared
// statement across calls (labelling queries every node in a cluster).
export function getNodeText(nodeId) {
  if (!_handle) return null;
  const { db, idByRow } = _handle;
  const paperId = idByRow[nodeId];
  if (paperId == null) return null;
  const stmt = _handle.textStmt ||
    (_handle.textStmt = db.prepare("SELECT title, abstract FROM papers WHERE id = ?"));
  stmt.reset();
  stmt.bind([paperId]);
  if (!stmt.step()) return null;
  const [title, abstract] = stmt.get();
  const parts = [];
  if (title) parts.push(title);
  if (abstract) parts.push(abstract);
  return parts.length ? parts.join(". ") : null;
}

// Whether a live sqlite corpus is loaded (so callers can decide whether to
// offer text-based labelling). True after a successful produceSqlite().
export function hasSqliteText() {
  return _handle != null;
}
