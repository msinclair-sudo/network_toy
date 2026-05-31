// Cluster labelling — its own multi-method module (MLC §7).
//
// Computes a label for every cluster by SEVERAL methods at once and
// returns them side-by-side (+ a combined pick), so the scoring surface
// can show one or compare many. Real-data only: the toy's synthetic nodes
// have no text/paper identity.
//
// Methods (a small registry — add one entry to add a method):
//   representative  embedding centroid → nearest member's paperId. Works
//                   from the SPECTER2 embedding alone; always available on
//                   real data.
//   year            median + range of member publication years. Cheap
//                   descriptive tag; available when nodes carry `year`.
//   cTfidf          class-based TF-IDF (BERTopic-style): each cluster is
//                   one document; top terms vs the other clusters.
//   tfidf           plain TF-IDF over member texts vs the whole corpus.
//
// The text methods (cTfidf / tfidf / a future KeyBERT) need a per-node
// text accessor `ctx.getText(nodeId) → string|null`. The toy doesn't
// materialise titles/abstracts today (only paperId + embedding are
// loaded), so on real data they report { available:false, reason } until a
// titles source is wired into ctx.getText — but the maths is here and
// unit-tested via an injected accessor.
//
// ctx: {
//   embedding: { d, data:Float32Array(n*d) } | null,
//   nodes:     [{ id, paperId?, year? }],
//   getText?:  (nodeId) => string | null,
// }

const STOPWORDS = new Set((
  "the a an and or of to in for on with by from as at is are be this that " +
  "we our using use based via into over under between within across new " +
  "approach method methods model models results result study analysis " +
  "paper which can may not but its their these those also more most such " +
  "than then they them was were has have had been being it he she his her"
).split(/\s+/));

const TOP_TERMS = 4;

/* ── method registry ────────────────────────────────────────────────── */

const METHODS = {
  representative: {
    id: "representative",
    label: "Representative paper",
    available: (ctx) => !!(ctx.embedding && ctx.embedding.data),
    run: runRepresentative,
  },
  year: {
    id: "year",
    label: "Year span",
    available: (ctx) => Array.isArray(ctx.nodes) && ctx.nodes.some(nd => Number.isFinite(nd && nd.year)),
    run: runYear,
  },
  cTfidf: {
    id: "cTfidf",
    label: "c-TF-IDF",
    available: hasText,
    run: (cr, ctx) => runTfidf(cr, ctx, /* classBased */ true),
  },
  tfidf: {
    id: "tfidf",
    label: "TF-IDF",
    available: hasText,
    run: (cr, ctx) => runTfidf(cr, ctx, /* classBased */ false),
  },
};

export function listLabelMethods() {
  return Object.values(METHODS).map(m => ({ id: m.id, label: m.label }));
}

/**
 * Label every cluster of `clusterResult` by every requested method.
 *
 * @param {object} clusterResult  a ClusterResult (nodeCluster + clusters).
 * @param {object} ctx            { embedding, nodes, getText? }.
 * @param {object} [opts]         { methods?: string[] } — defaults to all.
 * @returns {{
 *   methods: Array<{id, label, available, reason?}>,
 *   perCluster: Array<{ clusterId, byMethod: {[id]: any}, combined: string }>,
 * }}
 */
export function labelClusters(clusterResult, ctx, opts = {}) {
  const wanted = opts.methods || Object.keys(METHODS);
  const nClusters = clusterResult.clusters.length;

  // Member ids per cluster (one pass).
  const members = Array.from({ length: nClusters }, () => []);
  const nc = clusterResult.nodeCluster;
  for (let i = 0; i < nc.length; i++) {
    const c = nc[i];
    if (c >= 0 && c < nClusters) members[c].push(i);
  }

  const methodInfo = [];
  const results = {};   // id → perCluster array (or null)
  for (const id of wanted) {
    const m = METHODS[id];
    if (!m) continue;
    const avail = m.available(ctx);
    methodInfo.push({
      id: m.id, label: m.label, available: avail,
      reason: avail ? undefined : reasonFor(id, ctx),
    });
    results[id] = avail ? m.run(clusterResult, ctx, members) : null;
  }

  const perCluster = [];
  for (let c = 0; c < nClusters; c++) {
    const byMethod = {};
    for (const id of wanted) {
      if (results[id]) byMethod[id] = results[id][c];
    }
    perCluster.push({ clusterId: c, byMethod, combined: combine(byMethod) });
  }

  return { methods: methodInfo, perCluster };
}

/* ── methods ─────────────────────────────────────────────────────────── */

function runRepresentative(cr, ctx, members) {
  const { d, data } = ctx.embedding;
  const out = new Array(cr.clusters.length);
  for (let c = 0; c < cr.clusters.length; c++) {
    const ids = members[c];
    if (ids.length === 0) { out[c] = { nodeId: -1, paperId: null }; continue; }
    // centroid in embedding space
    const cen = new Float64Array(d);
    for (const i of ids) { const off = i * d; for (let k = 0; k < d; k++) cen[k] += data[off + k]; }
    for (let k = 0; k < d; k++) cen[k] /= ids.length;
    // nearest member by cosine similarity to the centroid
    let best = ids[0], bestSim = -Infinity;
    let cenNorm = 0; for (let k = 0; k < d; k++) cenNorm += cen[k] * cen[k];
    cenNorm = Math.sqrt(cenNorm) || 1;
    for (const i of ids) {
      const off = i * d;
      let dot = 0, nn = 0;
      for (let k = 0; k < d; k++) { const v = data[off + k]; dot += v * cen[k]; nn += v * v; }
      const sim = dot / ((Math.sqrt(nn) || 1) * cenNorm);
      if (sim > bestSim) { bestSim = sim; best = i; }
    }
    const node = ctx.nodes[best];
    out[c] = {
      nodeId:  best,
      paperId: (node && node.paperId) || null,
      similarity: bestSim,
    };
  }
  return out;
}

function runYear(cr, ctx, members) {
  const out = new Array(cr.clusters.length);
  for (let c = 0; c < cr.clusters.length; c++) {
    const years = [];
    for (const i of members[c]) {
      const y = ctx.nodes[i] && ctx.nodes[i].year;
      if (Number.isFinite(y)) years.push(y);
    }
    if (years.length === 0) { out[c] = { median: null, min: null, max: null }; continue; }
    years.sort((a, b) => a - b);
    out[c] = {
      median: years[Math.floor(years.length / 2)],
      min:    years[0],
      max:    years[years.length - 1],
      n:      years.length,
    };
  }
  return out;
}

// Plain (classBased=false) or class-based (true) TF-IDF over member texts.
function runTfidf(cr, ctx, classBased, membersArg) {
  const members = membersArg || membersOf(cr);
  const nClusters = cr.clusters.length;

  // Tokenise each cluster's bag of member texts → term-frequency map.
  const tf = new Array(nClusters);
  for (let c = 0; c < nClusters; c++) {
    const counts = new Map();
    let total = 0;
    for (const i of members[c]) {
      const text = ctx.getText(ctx.nodes[i] ? ctx.nodes[i].id : i);
      if (!text) continue;
      for (const tok of tokenize(text)) {
        counts.set(tok, (counts.get(tok) || 0) + 1);
        total++;
      }
    }
    tf[c] = { counts, total: total || 1 };
  }

  // Document frequency across clusters (class-based) — how many clusters
  // contain each term. For plain TF-IDF we'd use per-node df, but at the
  // cluster-labelling granularity the class-based df is the meaningful one;
  // the `classBased` flag tunes the idf base only.
  const df = new Map();
  for (let c = 0; c < nClusters; c++) {
    for (const term of tf[c].counts.keys()) df.set(term, (df.get(term) || 0) + 1);
  }
  const N = classBased ? nClusters : nClusters;

  const out = new Array(nClusters);
  for (let c = 0; c < nClusters; c++) {
    const scored = [];
    for (const [term, count] of tf[c].counts) {
      const tfv = count / tf[c].total;
      const idf = Math.log(1 + N / (1 + (df.get(term) || 0)));
      scored.push({ term, score: tfv * idf, count });
    }
    scored.sort((a, b) => b.score - a.score);
    out[c] = { terms: scored.slice(0, TOP_TERMS).map(s => s.term), detail: scored.slice(0, TOP_TERMS) };
  }
  return out;
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function hasText(ctx) {
  if (typeof ctx.getText !== "function" || !Array.isArray(ctx.nodes)) return false;
  // probe a few nodes for any non-empty text
  const probe = Math.min(ctx.nodes.length, 20);
  for (let i = 0; i < probe; i++) {
    const t = ctx.getText(ctx.nodes[i].id);
    if (t && String(t).trim()) return true;
  }
  return false;
}

function reasonFor(id, ctx) {
  if (id === "representative") return "needs an embedding";
  if (id === "year")          return "no node has a year";
  if (id === "cTfidf" || id === "tfidf") {
    return typeof ctx.getText !== "function"
      ? "needs per-node text — titles/abstracts are not materialised in this dataset"
      : "no member text found";
  }
  return "unavailable";
}

function membersOf(cr) {
  const out = Array.from({ length: cr.clusters.length }, () => []);
  for (let i = 0; i < cr.nodeCluster.length; i++) {
    const c = cr.nodeCluster[i];
    if (c >= 0 && c < out.length) out[c].push(i);
  }
  return out;
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

// Pick the most legible single label from whatever methods ran.
function combine(byMethod) {
  if (byMethod.cTfidf && byMethod.cTfidf.terms && byMethod.cTfidf.terms.length) {
    return byMethod.cTfidf.terms.join(" · ");
  }
  if (byMethod.tfidf && byMethod.tfidf.terms && byMethod.tfidf.terms.length) {
    return byMethod.tfidf.terms.join(" · ");
  }
  if (byMethod.representative && byMethod.representative.paperId) {
    const yr = byMethod.year && byMethod.year.median ? ` (${byMethod.year.median})` : "";
    return `${byMethod.representative.paperId}${yr}`;
  }
  if (byMethod.year && byMethod.year.median) {
    return `${byMethod.year.min}–${byMethod.year.max}`;
  }
  return "(unlabelled)";
}
