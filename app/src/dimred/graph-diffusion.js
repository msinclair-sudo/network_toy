// Graph-diffusion fusion: citation-aware re-embedding.
//
// Citation-aware embedding refinement using anchored graph
// diffusion (APPNP — Klicpera, Bojchevski, Günnemann, ICLR 2019).
// Pulls papers that cite each other closer in feature space while
// keeping each paper anchored to its original SPECTER2 vector, so
// no paper "drifts away" entirely. The iteration:
//
//   X'⁽⁰⁾ = X                               (input embedding, n × d)
//   X'⁽ᵏ⁺¹⁾ = (1 − α)·X + α·(D⁻¹A)·X'⁽ᵏ⁾    (anchored diffusion)
//
// Has a closed-form fixed point X'∞ = (1−α)(I − αD⁻¹A)⁻¹X for α < 1.
// Numerically stable; values stay bounded by min/max of original X
// (each iteration is a convex combination).
//
// Convention note: we use α as "mixing strength" (higher → more
// citation influence). The APPNP paper uses α as "teleport
// probability" with the opposite sense (higher → stay at X).
// Mathematically equivalent under (α_ours = 1 − α_APPNP); chosen
// here so sliders read intuitively (right = more fusion).
//
// Input citation edges live in `params.adjacency` — a flat
// number[] of length 2|E| in [src, dst, src, dst, …] form. Symmetric
// fusion is the default: we treat A ∨ Aᵀ so direction doesn't matter.
// The 5000-paper BFS subset has 100% coverage (no isolates); for
// safety we handle isolated rows by adding a self-loop so D⁻¹ doesn't
// divide by zero.
//
// Family: ["fusion"] — sits between Layer 1.5's noise stage and the
// downstream sibling triple (compression / viz / viz2d). Input and
// output have the same dimensionality (lateral stage, not a
// reduction).

import { mulberry32 as _mulberry32 } from "../rng.js";

export const ID = "graph-diffusion";

export const defaultParams = () => ({
  // Mixing strength per iteration. 0 = identity (no fusion); higher
  // = more citation influence. Recommended 0.3 — mild fusion that
  // preserves SPECTER2's semantic content while letting citation
  // structure refine the topic map.
  alpha: 0.3,
  // Diffusion depth. Each iteration moves information one hop along
  // the citation graph. k=4 covers most short-path influence on a
  // giant component; higher values reach further but also dilute
  // the original signal more.
  iterations: 4,
  // Adjacency injected by the engine at compute() time. Empty by
  // default — fusion behaves as identity until citation edges arrive.
  // Flat number[] of length 2|E|: [src0, dst0, src1, dst1, …].
  adjacency: [],
});

export function compute(input, params = {}) {
  const p = { ...defaultParams(), ...params };
  const n = input.n;
  const d = input.d;
  const X = input.data;        // Float32Array(n*d), input embedding

  // No edges supplied or n < 2 → identity. Common for toy mode where
  // citations don't exist before clustering; redimred runs fusion
  // anyway but it's a no-op.
  if (!p.adjacency || p.adjacency.length === 0 || n < 2) {
    return {
      method: ID,
      params: echoParams(p),
      n, d,
      data:   new Float32Array(X),       // copy so caller can't mutate
    };
  }

  // 1. Build CSR sparse adjacency. Symmetrise (A ∨ Aᵀ) by adding
  //    both directions for every edge. Dedupe with a hash set so we
  //    don't double-count parallel listings.
  const seen = new Set();
  const rowsTmp = new Array(n);
  for (let i = 0; i < n; i++) rowsTmp[i] = [];
  for (let k = 0; k < p.adjacency.length; k += 2) {
    const u = p.adjacency[k]     | 0;
    const v = p.adjacency[k + 1] | 0;
    if (u === v) continue;
    if (u < 0 || u >= n || v < 0 || v >= n) continue;
    const fwdKey = u * n + v;
    const revKey = v * n + u;
    if (!seen.has(fwdKey)) { seen.add(fwdKey); rowsTmp[u].push(v); }
    if (!seen.has(revKey)) { seen.add(revKey); rowsTmp[v].push(u); }
  }
  // CSR: rowPtr[i+1] − rowPtr[i] = degree(i); colIdx is concatenated
  // neighbour lists.
  const rowPtr = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) rowPtr[i + 1] = rowPtr[i] + rowsTmp[i].length;
  const nnz = rowPtr[n];
  const colIdx = new Int32Array(nnz);
  for (let i = 0, off = 0; i < n; i++) {
    const r = rowsTmp[i];
    for (let j = 0; j < r.length; j++) colIdx[off++] = r[j];
  }
  // Pre-compute inverse degree per row. Isolated rows (degree 0)
  // get inverse-degree 0 — combined with the (1−α)X·1 anchor term,
  // the propagation row simply contributes nothing for these nodes,
  // leaving X' = X for isolates.
  const invDeg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const deg = rowPtr[i + 1] - rowPtr[i];
    invDeg[i] = deg > 0 ? 1 / deg : 0;
  }

  // 2. Iterate X' ← (1−α)X + α·(D⁻¹A)·X'. Two buffers ping-ponged.
  const alpha = clampFloat(p.alpha, 0, 0.999);   // clamp at <1 to guarantee fixed point
  const oneMinusAlpha = 1 - alpha;
  const iters = clampInt(p.iterations, 0, 50);
  let cur  = new Float32Array(X);
  let next = new Float32Array(n * d);

  for (let iter = 0; iter < iters; iter++) {
    // For each row i, compute (D⁻¹A·cur)[i] = (1/deg[i]) · Σ_{j ∈ N(i)} cur[j].
    // Then mix: next[i] = (1−α)·X[i] + α·that.
    next.fill(0);
    for (let i = 0; i < n; i++) {
      const start = rowPtr[i];
      const end   = rowPtr[i + 1];
      const inv   = invDeg[i] * alpha;
      const offI  = i * d;
      // Sum neighbour contributions weighted by α/deg, into next[i].
      // Loop order (neighbour outer, dim inner) preserves cache
      // locality on the cur buffer.
      for (let k = start; k < end; k++) {
        const offJ = colIdx[k] * d;
        for (let f = 0; f < d; f++) next[offI + f] += inv * cur[offJ + f];
      }
      // Add the anchor (1−α)·X[i]. inv==0 rows skip the neighbour
      // sum entirely so they fall through as pure X.
      for (let f = 0; f < d; f++) next[offI + f] += oneMinusAlpha * X[offI + f];
    }
    // Swap buffers for the next iteration.
    const tmp = cur; cur = next; next = tmp;
  }

  return {
    method: ID,
    params: echoParams(p),
    n, d,
    data: cur,
  };
}

function echoParams(p) {
  // Echo only the user-facing knobs, not the injected adjacency
  // (it's recomputable from state, large, and noisy in saved JSON).
  return {
    alpha:      p.alpha,
    iterations: p.iterations,
    edgeCount:  p.adjacency ? Math.floor(p.adjacency.length / 2) : 0,
  };
}

function clampInt(x, lo, hi) {
  const v = Math.round(+x || 0);
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function clampFloat(x, lo, hi) {
  const v = +x || 0;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
