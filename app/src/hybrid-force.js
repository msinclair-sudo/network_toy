// Layer 4 — the hybrid spring force.
//
// Pure factory: returns a force function compatible with d3-force-3d's
// force(simAlpha) signature. The factory closes over getter callbacks so it
// reads live α / hasCit / baseDist every tick — no reheat needed when those
// inputs change downstream.
//
// Math reference: doc/dynamics.md §4.
//
// One spring per unordered pair (i, j). For every pair:
//   semRest_ij = ‖basePos_i − basePos_j‖    (frozen at generation; passed via getBaseDist)
//
//   if hasCit[i,j]:
//       ℓ_ij  =  max(0, (1 − α) · semRest_ij)
//       s_ij  =  max(1, α)
//   else:
//       ℓ_ij  =  semRest_ij
//       s_ij  =  1
//
// Spring update (toward ℓ_ij):
//   k = STRENGTH · s_ij · simAlpha · (d − ℓ) / d
//   v_i += k · Δ ;  v_j -= k · Δ ;  (Δ = x_j − x_i)
//
// Charge and the library's link force are zeroed by the caller so this
// is the only force shaping the layout.

export const DEFAULT_STRENGTH = 0.04;

// Light per-pair tension cache so debug overlays (and anyone else who needs
// per-spring state) can read what the most recent tick computed without
// recomputing it. The force writes `tension[i*n + j] = (d − ℓ) / max(d, eps)`
// — positive values mean stretched, negative means compressed. Symmetric:
// tension[j*n + i] mirrors tension[i*n + j].
//
// Indexed by node ids 0..n-1.
export function makeTensionCache(n) {
  return new Float32Array(n * n);
}

// Build a force.
//
// Required getters:
//   getAlpha()      → number  (the user-facing α; not the simAlpha)
//   getNodes()      → array of {id, x, y, z, vx, vy, vz}
//                     (3d-force-graph passes its own list via .initialize)
//   getBaseDist()   → Float32Array(n*n) of pairwise basePos distances
//   getHasCit()     → Uint8Array(n*n) symmetric citation flags
//
// Optional:
//   strength            → STRENGTH constant (default 0.04)
//   getTensionCache()   → returns a Float32Array(n*n) to write per-spring
//                         tension into, OR null. Read every tick so the
//                         caller can swap arrays after regen without
//                         re-registering the force.
export function makeHybridForce({
  getAlpha,
  getBaseDist,
  getHasCit,
  getTensionCache = () => null,
  strength = DEFAULT_STRENGTH,
} = {}) {
  let nodes = [];
  function force(simAlpha) {
    const n = nodes.length;
    if (n === 0) return;
    const baseD = getBaseDist();
    const cit   = getHasCit();
    if (!baseD || !cit) return;
    const A = +getAlpha() || 0;
    const oneMinusA = 1 - A;
    const STRENGTH = strength;
    const tens = getTensionCache();
    const tensValid = tens && tens.length >= n * n;

    for (let i = 0; i < n; i++) {
      const ni = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const nj = nodes[j];
        const semRest = baseD[i * n + j];
        const cited = cit[i * n + j];
        const rest = cited ? Math.max(0, oneMinusA * semRest) : semRest;
        const sMul = cited ? Math.max(1, A) : 1;

        let dx = nj.x - ni.x, dy = nj.y - ni.y, dz = nj.z - ni.z;
        const d = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-6;
        const k = STRENGTH * sMul * simAlpha * (d - rest) / d;
        const fx = k * dx, fy = k * dy, fz = k * dz;
        ni.vx += fx; ni.vy += fy; ni.vz += fz;
        nj.vx -= fx; nj.vy -= fy; nj.vz -= fz;

        if (tensValid) {
          // Normalised tension: + means stretched, − means compressed.
          // Clamped to [-1, 1] for downstream colour mapping.
          let t = (d - rest) / Math.max(d, 1e-3);
          if (t > 1) t = 1; else if (t < -1) t = -1;
          tens[i * n + j] = t;
          tens[j * n + i] = t;
        }
      }
    }
  }
  force.initialize = function (_nodes) { nodes = _nodes; };
  return force;
}
