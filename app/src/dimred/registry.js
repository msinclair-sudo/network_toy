// Dim-reduction algorithm registry (Layer 1.5).
//
// Layer 1.5 has THREE stages: noise reduction, dimension compression
// (clustering input), and visualisation reduction (viewer / blend
// input). Compression and viz are siblings — both fork off the noise
// stage's output. Each entry declares which slots it's eligible for
// via a `family` array of strings ("noise" | "compression" | "viz" |
// "any"). "any" means usable in any slot — currently just `identity`,
// which acts as "skip this stage".
//
// Adding a new algorithm = one entry here. `listAlgorithms(slot)`
// filters; the dim-reduction modal renders one section per slot and
// drops in only the matching entries.
//
// Contract: every `compute` returned must satisfy the contract in
// app/src/dimred/contract.js, validated by validateDimredResult. The
// validator runs in engine.js on every redimred() so contract
// violations surface immediately when adding a new algorithm.
//
// New algorithm signature: `compute(input, params)` where input is
// `{n, d, data: Float32Array(n*d)}`. Stages chain: stage 1's output
// (which is itself a DimredResult) becomes stage 2's input.

import { computeIdentity, defaultIdentityParams } from "./identity.js";
import { computePca,      defaultPcaParams      } from "./pca.js";
import { computeUmap,     defaultUmapParams     } from "./umap.js";

export const ALGORITHMS = [
  {
    id: "identity",
    label: "Identity (skip)",
    family: ["any"],
    description: "Don't reduce — pass the data straight through. Use this to skip a stage you don't need.",
    defaultParams: defaultIdentityParams,
    compute: (input, params) => computeIdentity(input, params),
    modalSchema: [],
  },
  {
    id: "pca",
    label: "PCA",
    family: ["noise"],
    description: "Squashes high-dimensional data onto its main axes of variation. Useful for cleaning up noise BEFORE running UMAP — it strips out tiny variations that don't carry real structure. PCA on its own is rarely a great clustering input for embeddings; pair it with UMAP in the compression stage.",
    defaultParams: defaultPcaParams,
    // Slot-specific defaults override defaultParams() when the user
    // picks an algorithm in a particular slot. PCA is only registered
    // for the noise slot; we recommend 100 (the locked denoiser size).
    defaultParamsForSlot: (_slot) => ({ n_components: 100 }),
    compute: (input, params) => computePca(input, params),
    modalSchema: [
      {
        key: "n_components",
        label: "Output dimensions",
        kind: "int",
        min: 1, max: 200, step: 1,
        format: (v) => String(v),
        hint: "How many directions to keep. Recommended: 100 — keeps the signal in 768-d embeddings while dropping noise. Compute clamps automatically when the input has fewer dimensions, so it's safe to leave at 100 even for toy data.",
        sweepValues: [50, 100, 200],
      },
    ],
  },
  {
    id: "umap",
    label: "UMAP",
    family: ["compression", "viz", "viz2d"],
    description: "Builds a map that keeps similar points near each other. Use it in the compression stage to give clustering a clean ~50-d input; use it in the visualisation stage to reduce to 3-d (or 2-d) for the viewer.",
    defaultParams: defaultUmapParams,
    // Slot-specific defaults — these are the locked values from
    // clustering-research §4. Compression: tight clusters (min_dist=0)
    // at 50-d with broad neighbours (50). Viz (3-d): a few looser
    // clusters at 3-d with smaller neighbour windows (15) — better
    // for an interactive viewer. Viz2d: 2-d analogue with a distinct
    // seed so the 2D and 3D fits don't sync. Distinct random_state
    // per slot so re-running one doesn't accidentally jiggle others.
    defaultParamsForSlot: (slot) => {
      if (slot === "compression") {
        return { n_components: 50, n_neighbors: 50, min_dist: 0.0, metric: "cosine", random_state: 42 };
      }
      if (slot === "viz") {
        return { n_components: 3,  n_neighbors: 15, min_dist: 0.1, metric: "cosine", random_state: 43 };
      }
      if (slot === "viz2d") {
        return { n_components: 2,  n_neighbors: 15, min_dist: 0.1, metric: "cosine", random_state: 44 };
      }
      return defaultUmapParams();
    },
    compute: (input, params) => computeUmap(input, params),
    modalSchema: [
      {
        key: "n_components",
        label: "Output dimensions",
        kind: "int",
        min: 1, max: 100, step: 1,
        format: (v) => String(v),
        hint: "How many dimensions the map should have. Recommended: 50 for compression (clustering input), 3 for the 3-d viewer, 2 for a flat scatterplot.",
        sweepValues: [3, 10, 30, 50, 100],
      },
      {
        key: "n_neighbors",
        label: "Neighbours per point",
        kind: "int",
        min: 2, max: 100, step: 1,
        format: (v) => String(v),
        hint: "How many nearby points each point looks at when building the map. Recommended: 50 for compression (broader context, better global structure for clustering), 15 for visualisation (tighter local groups). Small values zoom into local detail; large values bias toward the big picture.",
        sweepValues: [5, 15, 30, 50, 100],
      },
      {
        key: "min_dist",
        label: "Cluster tightness",
        kind: "range",
        min: 0, max: 1, step: 0.05,
        format: (v) => (+v).toFixed(2),
        hint: "How tightly to pack points within a cluster. Recommended: 0 for compression (clusters as compact as possible — best for clustering), 0.1 for visualisation (slightly spread out for readable rendering).",
        sweepValues: [0.0, 0.1, 0.25, 0.5],
      },
      {
        key: "metric",
        label: "Distance metric",
        kind: "select",
        options: [
          { value: "cosine",    label: "Cosine (best for text/embeddings)" },
          { value: "euclidean", label: "Euclidean (best for spatial data)" },
        ],
        hint: "How to measure 'closeness' between points. Cosine is right for word/document embeddings (it ignores raw magnitude); Euclidean is right when the coordinates have direct spatial meaning, like the toy generator's basePos.",
        sweepValues: ["cosine"],
      },
    ],
  },
];

const BY_ID = new Map(ALGORITHMS.map(a => [a.id, a]));

export function getAlgorithm(id) {
  const a = BY_ID.get(id);
  if (!a) throw new Error(`[DimredRegistry] unknown algorithm "${id}"`);
  return a;
}

// `slot` is optional. When omitted, returns every entry. Otherwise
// returns entries whose family array includes the slot OR includes
// "any".
export function listAlgorithms(slot) {
  if (!slot) return ALGORITHMS.slice();
  return ALGORITHMS.filter(a => {
    const fam = Array.isArray(a.family) ? a.family : [a.family];
    return fam.includes(slot) || fam.includes("any");
  });
}
