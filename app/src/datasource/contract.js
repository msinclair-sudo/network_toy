// Data-source output contract (Layer 1).
//
// Every data-source produces this shape. The engine validates it once
// on the way out so contract violations surface immediately when
// adding a new source.
//
// Shape:
//   {
//     nodes: [{
//       id:        int,                 // contiguous 0..n-1
//       t:         number ∈ [0, 1],      // timestamp / publication-year-normalised
//       originId?: int | null,            // toy ground-truth label; null for real
//       basePos?:  [x, y, z],             // optional per-node viz position
//                                         //   (toy supplies it; real does not — Layer 1.5
//                                         //    viz sub-stage backfills it)
//     }],
//     origins?:   [{id, centre, spread, colour}, ...],
//                                         // toy ground-truth mixture components; null for real
//     embedding?: { d, data: Float32Array(n*d) },
//                                         // high-dim feature vectors per node (real ingest);
//                                         // absent for toy where basePos serves as the
//                                         // (3-d) embedding directly
//     basePos?:   Float32Array(n*3),       // optional flat viz buffer; either nodes carry
//                                         // basePos or this is supplied — engine packs whichever's present
//   }
//
// Combinations a data-source may legally produce:
//   * toy:  nodes[i].basePos + origins              (no embedding; basePos role doubled as embedding for Layer 1.5 identity)
//   * real: embedding only                           (no basePos, no origins; viz sub-stage produces basePos)
//   * any source supplying basePos directly         (e.g. a future "load existing 3-d coords" source)
//
// Either embedding or basePos (or both) must be present, otherwise
// downstream layers have nothing to chew on.

export const DATASOURCE_CONTRACT_VERSION = 1;

export function validateDataSourceResult(result) {
  fail(result && typeof result === "object", "result must be an object");
  fail(Array.isArray(result.nodes), "result.nodes must be an array");
  const n = result.nodes.length;
  fail(n > 0, "result.nodes must be non-empty");

  for (let i = 0; i < n; i++) {
    const node = result.nodes[i];
    fail(node && typeof node === "object", `nodes[${i}] must be an object`);
    fail(node.id === i,                    `nodes[${i}].id must equal ${i} (got ${node.id})`);
    fail(Number.isFinite(node.t),           `nodes[${i}].t must be a finite number`);
    if (node.basePos !== undefined && node.basePos !== null) {
      fail(Array.isArray(node.basePos) && node.basePos.length === 3 && node.basePos.every(Number.isFinite),
           `nodes[${i}].basePos must be a 3-vec of finite numbers`);
    }
  }

  if (result.embedding !== undefined && result.embedding !== null) {
    const e = result.embedding;
    fail(Number.isInteger(e.d) && e.d > 0,    "embedding.d must be a positive integer");
    fail(e.data instanceof Float32Array,       "embedding.data must be a Float32Array");
    fail(e.data.length === n * e.d,
         `embedding.data.length must equal n*d (${n * e.d}); got ${e.data.length}`);
  }

  if (result.basePos !== undefined && result.basePos !== null) {
    fail(result.basePos instanceof Float32Array,
         "result.basePos must be a Float32Array");
    fail(result.basePos.length === n * 3,
         `result.basePos.length must equal n*3 (${n * 3}); got ${result.basePos.length}`);
  }

  // Per-node basePos OR top-level basePos OR embedding must be present —
  // otherwise Layer 1.5 has nothing to consume and the viewer can't
  // render. Embedding alone is a valid "real-data, viz-not-yet-fitted"
  // state.
  const hasNodeBasePos = result.nodes.every(n => Array.isArray(n.basePos) && n.basePos.length === 3);
  const hasFlatBasePos = result.basePos instanceof Float32Array;
  const hasEmbedding   = result.embedding && result.embedding.data;
  fail(hasNodeBasePos || hasFlatBasePos || hasEmbedding,
       "data source must supply at least one of: per-node basePos, top-level basePos, or embedding");
}

function fail(ok, msg) {
  if (!ok) throw new Error(`[datasource contract] ${msg}`);
}
