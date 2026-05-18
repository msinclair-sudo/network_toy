// Real-data data source — loads SPECTER2 embedding subsets from
// literture-network/artifacts/.
//
// Produces a DataSourceResult with nodes (id + t) and a high-dim
// embedding ({d:768, data:Float32Array(n*d)}). NO basePos: the viewer
// stays empty until the user opts into a viz reduction in Layer 1.5
// (UMAP-3 over the embedding). Per spec — large datasets shouldn't
// auto-render.
//
// The actual fetch happens through the static http server, which is
// expected to serve the repo root (so /literture-network/artifacts/...
// resolves alongside /app/). For now there's exactly one subset shipped
// (dev_subset_1000); add new entries to SUBSETS as more are carved.

const SUBSETS = {
  // id → {label, embeddingsPath, indexPath}; paths are absolute fetch URLs
  // (the static server is rooted at the repo root).
  "dev_subset_1000": {
    label:          "dev_subset (1000 papers, seed 42)",
    embeddingsPath: "/literture-network/artifacts/dev_subset/expanded_embeddings.npy",
    indexPath:      "/literture-network/artifacts/dev_subset/expanded_embeddings_paper_index.json",
  },
};

export const SUBSET_IDS = Object.keys(SUBSETS);

export const defaultRealParams = () => ({
  subset: "dev_subset_1000",
});

export async function produceReal(params = {}) {
  const subsetId = params.subset || "dev_subset_1000";
  const subset   = SUBSETS[subsetId];
  if (!subset) throw new Error(`[datasource:real] unknown subset "${subsetId}"`);

  const [ab, paperIndex] = await Promise.all([
    fetch(subset.embeddingsPath).then(r => r.arrayBuffer()),
    fetch(subset.indexPath).then(r => r.json()),
  ]);

  const { shape, data } = parseNpy(ab);
  const [n, d] = shape;

  // Per-node metadata. We have no publication years in this subset
  // (the JSON only carries paper_id), so t defaults to 0. When a
  // year-bearing index lands we read it here.
  const nodes = new Array(n);
  for (let i = 0; i < n; i++) {
    nodes[i] = {
      id:       i,
      t:        0,
      paperId:  paperIndex[String(i)] || null,
    };
  }

  return {
    method:    "real",
    params:    { subset: subsetId },
    nodes,
    embedding: { d, data },
    // No basePos — Layer 1.5's viz sub-stage will populate _basePos when
    // the user picks a real algorithm there.
  };
}

// Minimal NPY v1/v2 reader. Parses the magic + header, returns the raw
// Float32Array payload along with shape. Only supports '<f4' dtype,
// which is what step02_embeddings.py writes; we'll grow this if/when
// other dtypes show up.
function parseNpy(arrayBuffer) {
  const u8 = new Uint8Array(arrayBuffer);
  if (u8[0] !== 0x93 ||
      u8[1] !== 0x4e || u8[2] !== 0x55 || u8[3] !== 0x4d ||
      u8[4] !== 0x50 || u8[5] !== 0x59) {
    throw new Error("[datasource:real] not an .npy file (bad magic)");
  }
  const major = u8[6];
  let headerLen, headerStart;
  if (major === 1) {
    headerLen = u8[8] | (u8[9] << 8);
    headerStart = 10;
  } else {
    const dv = new DataView(arrayBuffer);
    headerLen = dv.getUint32(8, true);
    headerStart = 12;
  }
  const header = new TextDecoder("ascii").decode(u8.slice(headerStart, headerStart + headerLen));

  const shapeMatch = /'shape':\s*\(([^)]*)\)/.exec(header);
  if (!shapeMatch) throw new Error(`[datasource:real] no shape in npy header: ${header}`);
  const shape = shapeMatch[1].split(",").map(s => parseInt(s.trim(), 10)).filter(Number.isFinite);

  const descrMatch = /'descr':\s*'([^']+)'/.exec(header);
  if (!descrMatch || descrMatch[1] !== "<f4") {
    throw new Error(`[datasource:real] expected dtype '<f4'; got ${descrMatch && descrMatch[1]}`);
  }

  const dataStart = headerStart + headerLen;
  const data = new Float32Array(arrayBuffer.slice(dataStart));
  if (shape.length !== 2 || data.length !== shape[0] * shape[1]) {
    throw new Error(`[datasource:real] shape ${shape} does not match data length ${data.length}`);
  }
  return { shape, data };
}
