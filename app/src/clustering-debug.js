// Clustering debug visualization.
//
// Lives entirely separate from the clustering pure module. Reads an
// inferClusters() result and produces:
//   - per-cluster centroid markers (a custom THREE gizmo, distinct from the
//     origin gizmo so the two cannot be confused);
//   - graph links for the mutual k-NN edges (the edges that defined the
//     connected components).
//
// Toggles via debugFlags. All flags default OFF — the production view should
// not show clustering debug noise. Open Debug ▾ to enable.

const CENTROID_NODE_PREFIX = "centroid:";

export const clusterDebugFlags = {
  showCentroids: false,
  showMutualEdges: false,
};

// Inject extra "node" entries (centroid markers) and "link" entries (mutual
// k-NN pairs) into a graph-data object. Caller is responsible for merging
// these with whatever else they want to draw.
export function decorateGraphData(graphData, clusterResult) {
  if (!clusterResult) return graphData;
  const { clusters, mutualEdges } = clusterResult;

  if (clusterDebugFlags.showCentroids) {
    for (const c of clusters) {
      graphData.nodes.push({
        id: CENTROID_NODE_PREFIX + c.id,
        kind: "centroid",
        clusterId: c.id,
        x:  c.centre[0], y:  c.centre[1], z:  c.centre[2],
        fx: c.centre[0], fy: c.centre[1], fz: c.centre[2],
      });
    }
  }
  if (clusterDebugFlags.showMutualEdges) {
    for (const [i, j] of mutualEdges) {
      graphData.links.push({
        source: i,
        target: j,
        kind: "mutual-edge",
      });
    }
  }
  return graphData;
}

// Centroid gizmo — a small wire-tetrahedron, deliberately a different shape
// from the origin (octahedron+crosshair) so the two read as distinct concepts.
// Coloured with the cluster's own colour.
export function buildCentroidMarker(THREE, cluster) {
  const group = new THREE.Group();
  const colour = new THREE.Color(cluster.colour);
  const mat = new THREE.LineBasicMaterial({
    color: colour, transparent: true, opacity: 0.85,
  });
  const r = 2.6;
  // Tetrahedron vertices (regular, centred at origin).
  const v = [
    [ r,  r,  r],
    [ r, -r, -r],
    [-r,  r, -r],
    [-r, -r,  r],
  ];
  const edges = [
    [0,1],[0,2],[0,3],
    [1,2],[1,3],
    [2,3],
  ];
  const flat = [];
  for (const [a, b] of edges) flat.push(...v[a], ...v[b]);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(flat, 3));
  group.add(new THREE.LineSegments(geom, mat));
  group.userData.kind = "centroid-marker";
  return group;
}

export const __CENTROID_NODE_PREFIX = CENTROID_NODE_PREFIX;
