// Per-connected-component rigid alignment of citationPos to basePos.
//
// The citation-layout module produces a deterministic 3D arrangement
// in its own coordinate frame — orientation and centroid are
// arbitrary, picked by FR's initial random seeding plus 200
// iterations of force balance. Without anchoring it to basePos's
// frame, the slider transition from α=0 (basePos) to α=1
// (citationPos) makes nodes fly across the screen in arbitrary
// directions. We fix that here.
//
// Per-component (not whole-graph) Kabsch is the right granularity:
//
//   - A connected citation cluster has its INTERNAL geometry
//     dictated by FR (carries real topological information). We
//     preserve that by aligning rigidly — rotation + translation
//     only, no per-node deformation.
//   - The component's overall position and orientation in space are
//     undetermined by topology. We pick the choice that minimises
//     RMSD to the same nodes' basePos coordinates.
//   - An isolated node is a singleton component. Per-component
//     Kabsch on a single point is just translation: the node lands
//     exactly at its basePos. (Isolated nodes have zero topological
//     constraint, so this is the right answer — their citation
//     position should default to where they'd be without any
//     citations at all.)
//
// Whole-graph Kabsch instead of per-component would force a single
// rigid transform across the whole layout — components whose basePos
// centroids are far apart can't all be aligned simultaneously; you
// get a compromise that's wrong for everyone.
//
// Encapsulation: this module is the ONLY place where citationPos
// and basePos meet. The layout module never sees basePos; the
// blend's per-frame lerp consumes the OUTPUT of this alignment, not
// the raw FR positions.

import { mulberry32 } from "../rng.js";

// Compute alignedCitationPos by:
//   1. Building connected components of the citation graph.
//   2. For each component, computing the optimal rigid transform
//      (rotation R + translation t) that aligns its citationPos
//      subset to its basePos subset (Kabsch via Horn's quaternion).
//   3. Applying that transform to those nodes' positions.
//
// Returns a freshly-allocated Float32Array(n × 3). Inputs are not
// mutated.
//
// Singletons (degree-0 nodes / 1-node components) get their basePos
// directly — no rotation defined for one point.
//
// Two-node components: Kabsch reduces to translating the centroid
// and rotating around the axis between the two points; we delegate
// to the same Horn-quaternion solver, which produces a valid (if
// non-unique) rotation.
export function alignByComponent({ basePos, citationPos, edges, n }) {
  if (n === 0) return new Float32Array(0);
  if (basePos.length !== n * 3) throw new Error("alignByComponent: basePos length mismatch");
  if (citationPos.length !== n * 3) throw new Error("alignByComponent: citationPos length mismatch");

  const aligned = new Float32Array(n * 3);

  const comp = unionFind(n, edges);
  const groups = new Map();    // componentId → array of node ids
  for (let i = 0; i < n; i++) {
    const c = comp[i];
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(i);
  }

  for (const ids of groups.values()) {
    if (ids.length === 1) {
      // Singleton: just place at basePos.
      const id = ids[0];
      aligned[id*3]   = basePos[id*3];
      aligned[id*3+1] = basePos[id*3+1];
      aligned[id*3+2] = basePos[id*3+2];
      continue;
    }
    alignSubset(ids, basePos, citationPos, aligned);
  }

  return aligned;
}

// Compute Kabsch transform aligning citationPos[ids] → basePos[ids],
// then write the transformed positions into `out`.
function alignSubset(ids, basePos, citationPos, out) {
  const m = ids.length;

  // Centroids.
  let cx=0, cy=0, cz=0, bcx=0, bcy=0, bcz=0;
  for (const i of ids) {
    cx  += citationPos[i*3];     cy  += citationPos[i*3+1];     cz  += citationPos[i*3+2];
    bcx += basePos[i*3];         bcy += basePos[i*3+1];         bcz += basePos[i*3+2];
  }
  cx/=m; cy/=m; cz/=m; bcx/=m; bcy/=m; bcz/=m;

  // Cross-correlation S = Σ a · bᵀ where a = citation−c, b = base−bc.
  // (Reads "rotation that maps citation-centred → base-centred",
  // i.e. R applied to citationPos relative coords yields basePos
  // relative coords.)
  let Sxx=0,Sxy=0,Sxz=0,Syx=0,Syy=0,Syz=0,Szx=0,Szy=0,Szz=0;
  for (const i of ids) {
    const ax = citationPos[i*3]   - cx,  ay = citationPos[i*3+1] - cy,  az = citationPos[i*3+2] - cz;
    const bx = basePos[i*3]       - bcx, by = basePos[i*3+1]     - bcy, bz = basePos[i*3+2]     - bcz;
    Sxx += ax*bx; Sxy += ax*by; Sxz += ax*bz;
    Syx += ay*bx; Syy += ay*by; Syz += ay*bz;
    Szx += az*bx; Szy += az*by; Szz += az*bz;
  }

  // Horn's symmetric 4×4 N matrix. Eigenvector of largest eigenvalue
  // is the unit quaternion of the optimal rotation.
  const N = new Float64Array(16);
  N[0]  =  Sxx + Syy + Szz;
  N[5]  =  Sxx - Syy - Szz;
  N[10] = -Sxx + Syy - Szz;
  N[15] = -Sxx - Syy + Szz;
  N[1]  = N[4]  = Syz - Szy;
  N[2]  = N[8]  = Szx - Sxz;
  N[3]  = N[12] = Sxy - Syx;
  N[6]  = N[9]  = Sxy + Syx;
  N[7]  = N[13] = Szx + Sxz;
  N[11] = N[14] = Syz + Szy;

  const { eigvals, V } = jacobiEigenSym4(N);
  let best = 0;
  for (let i = 1; i < 4; i++) if (eigvals[i] > eigvals[best]) best = i;
  let qw = V[0*4 + best];
  let qx = V[1*4 + best];
  let qy = V[2*4 + best];
  let qz = V[3*4 + best];
  const qn = Math.sqrt(qw*qw + qx*qx + qy*qy + qz*qz) || 1;
  qw /= qn; qx /= qn; qy /= qn; qz /= qn;

  const r00 = 1 - 2*qy*qy - 2*qz*qz;
  const r01 = 2*qx*qy - 2*qw*qz;
  const r02 = 2*qx*qz + 2*qw*qy;
  const r10 = 2*qx*qy + 2*qw*qz;
  const r11 = 1 - 2*qx*qx - 2*qz*qz;
  const r12 = 2*qy*qz - 2*qw*qx;
  const r20 = 2*qx*qz - 2*qw*qy;
  const r21 = 2*qy*qz + 2*qw*qx;
  const r22 = 1 - 2*qx*qx - 2*qy*qy;

  // For each node in the component:
  //   aligned = R · (citation − c) + bc
  for (const i of ids) {
    const dx = citationPos[i*3]   - cx;
    const dy = citationPos[i*3+1] - cy;
    const dz = citationPos[i*3+2] - cz;
    out[i*3]   = r00*dx + r01*dy + r02*dz + bcx;
    out[i*3+1] = r10*dx + r11*dy + r12*dz + bcy;
    out[i*3+2] = r20*dx + r21*dy + r22*dz + bcz;
  }
}

// Connected components by union-find. Returns Int32Array(n) where
// each entry is the component representative id (chosen as the
// smallest id in that component after path compression).
function unionFind(n, edges) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  function find(x) {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let w = x;
    while (parent[w] !== r) { const nx = parent[w]; parent[w] = r; w = nx; }
    return r;
  }
  function unite(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) {
      // Keep the smaller id as the representative for stable output.
      if (ra < rb) parent[rb] = ra;
      else         parent[ra] = rb;
    }
  }
  for (const e of edges) unite(e[0], e[1]);
  // Final pass: compress every node to its root.
  const out = new Int32Array(n);
  for (let i = 0; i < n; i++) out[i] = find(i);
  return out;
}

// Cyclic Jacobi eigendecomposition for a symmetric 4×4 matrix.
// Same implementation as physics-debug.js (kept local so this
// module has no dependencies on debug code). Returns {eigvals, V}
// where V is row-major; column j is the eigenvector for eigvals[j].
function jacobiEigenSym4(N) {
  const A = new Float64Array(N);
  const V = new Float64Array(16);
  V[0] = V[5] = V[10] = V[15] = 1;
  for (let iter = 0; iter < 50; iter++) {
    let p = 0, q = 1, maxAbs = Math.abs(A[1]);
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const v = Math.abs(A[i*4 + j]);
        if (v > maxAbs) { maxAbs = v; p = i; q = j; }
      }
    }
    if (maxAbs < 1e-12) break;
    const apq = A[p*4 + q];
    const app = A[p*4 + p];
    const aqq = A[q*4 + q];
    const theta = (aqq - app) / (2 * apq);
    const t = (theta >= 0 ? 1 : -1) /
              (Math.abs(theta) + Math.sqrt(theta*theta + 1));
    const c = 1 / Math.sqrt(t*t + 1);
    const s = t * c;
    A[p*4 + p] = app - t * apq;
    A[q*4 + q] = aqq + t * apq;
    A[p*4 + q] = A[q*4 + p] = 0;
    for (let i = 0; i < 4; i++) {
      if (i === p || i === q) continue;
      const aip = A[i*4 + p];
      const aiq = A[i*4 + q];
      A[i*4 + p] = A[p*4 + i] = c * aip - s * aiq;
      A[i*4 + q] = A[q*4 + i] = s * aip + c * aiq;
    }
    for (let i = 0; i < 4; i++) {
      const vip = V[i*4 + p];
      const viq = V[i*4 + q];
      V[i*4 + p] = c * vip - s * viq;
      V[i*4 + q] = s * vip + c * viq;
    }
  }
  return { eigvals: [A[0], A[5], A[10], A[15]], V };
}
