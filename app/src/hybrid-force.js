// Layer 4 — Position-based distance-constraint solver.
//
// Replaces the previous spring-force model. The earlier damped spring
// system (force per pair → velocity → position) stored energy in
// velocities, oscillated on α changes, accumulated rigid drift, and
// required ever-tighter clamps at high N to stay stable. The user-
// visible behaviour we wanted — "α deforms the layout according to
// citation topology" — has no need for momentum or time-step
// coupling. So this layer is now stateless w.r.t. velocity.
//
// One distance constraint per unordered pair (i, j), each with a
// per-pair weight that scales how strongly it pulls when conflicting
// with other constraints touching the same node:
//
//   ℓ_ij  =  (1 − α/ALPHA_MAX) · semRest_ij   if cited
//         =                       semRest_ij  otherwise
//   w_ij  =  1 + α                            if cited
//         =  1                                otherwise
//   semRest_ij  =  ‖basePos_i − basePos_j‖    (frozen at generation)
//
// In the Jacobi solver, each node's per-tick correction is the
// weighted average of every constraint pulling on it:
//
//   Δp_i  =  Σ over pairs (i, *)  [ w_ij · half_ij · û_ij ]
//            ─────────────────────────────────────────────
//                       Σ w_ij                          .
//
// At α=0 every pair has weight 1 → equilibrium is basePos. As α rises:
//   - Cited rest length shrinks toward 0 (across the full slider range
//     so every step has bite — without rescaling the (1 − α) factor
//     clamps to 0 at α=1 and the rest of the slider is dead).
//   - Cited weight rises linearly to 1 + ALPHA_MAX, so cited
//     constraints dominate the conflict at each shared node. This is
//     what gives α > 1 real strength: not just "cited rests are
//     shorter" but "cited constraints win the tug-of-war when they
//     fight uncited basePos pulls."
//
// Per tick, we run K iterations. Each iteration visits every pair and
// applies Müller-style position-based projection:
//
//   d    = ‖xj − xi‖
//   C    = d − ℓ                              (constraint violation)
//   half = STIFFNESS · C / 2
//   û    = (xj − xi) / d                      (unit direction)
//   xi  += +half · û                          (move toward j)
//   xj  += −half · û                          (move toward i)
//
// Mass-equal projection: each node takes half the correction. Iterating
// K times approximates "hardness" 1 − (1 − STIFFNESS)^K, so STIFFNESS=0.5
// with K=4 gives ~94% constraint satisfaction per tick — soft enough
// for smooth visible motion, hard enough to converge in a couple of
// frames once α stabilises.
//
// Properties this gives us:
//   - No velocities, no oscillation, no overshoot.
//   - α changes drive monotonic motion toward the new equilibrium
//     (the constrained projection is a contraction toward the target).
//   - Per-tick motion magnitude is independent of N — each pair's
//     correction is bounded by C/2 regardless of how many other pairs
//     touch the same node, so high citation density just converges
//     a little slower instead of jittering.
//   - No simAlpha coupling: PBD doesn't depend on a time step. d3's
//     simAlpha decay still freezes the engine when the network has
//     stopped moving, which is what we want.
//
// d3-force-3d's "force" hook gives us a per-tick callback with mutable
// node references — we use that hook but mutate x/y/z directly instead
// of vx/vy/vz. main.js sets d3VelocityDecay to 1 so any stray velocity
// (e.g. from a prior force registration) zeros out immediately.

// Iteration count and stiffness chosen for Jacobi-style updates (each
// iteration uses snapshot positions, applies all corrections at end —
// see force loop). Eight iterations at stiffness 0.6 converges in ~the
// same number of frames as the previous Gauss-Seidel 4×0.5 setup, with
// no iteration-order bias.
export const PBD_ITERATIONS = 8;
export const PBD_STIFFNESS  = 0.6;

// α at which cited pair rest length reaches 0 (full collapse). The
// slider in app/index.html can go higher than this — past ALPHA_MAX
// the rest stays at 0, but the cited-pair WEIGHT keeps growing
// (citedWeight = 1 + α, uncapped), so cited constraints win the
// shared-node tug-of-war ever more decisively. This split lets the
// 0..5 range keep its familiar "rest length collapses" feel while
// 5..sliderMax becomes a "really exaggerate the citation effect"
// zone where uncited basePos pulls get progressively overpowered.
export const ALPHA_MAX = 5;

// Build a solver. Same getter-based wiring as before so downstream
// changes (α slider, citation reroll, regen) take effect on the next
// tick without re-registering this hook on the graph.
//
// Required getters:
//   getAlpha()      → number  (the user-facing α; ≥ 0)
//   getBaseDist()   → Float32Array(n×n) of pairwise basePos distances
//   getHasCit()     → Uint8Array(n×n)   symmetric citation flags
//   getBasePos()    → Float32Array(n×3) of basePos (used to anchor
//                     orientation after each PBD step — see the Kabsch
//                     pass below for why this is needed)
//
// Optional:
//   iterations  → solver iterations per tick (default PBD_ITERATIONS)
//   stiffness   → per-iteration correction fraction (default PBD_STIFFNESS)
export function makePbdSolver({
  getAlpha,
  getBaseDist,
  getHasCit,
  getBasePos,
  iterations = PBD_ITERATIONS,
  stiffness  = PBD_STIFFNESS,
} = {}) {
  let nodes = [];
  // Per-node correction accumulators + degree count, reused across
  // ticks. Jacobi iteration: each pair reads snapshot positions, writes
  // its half-correction into the accumulators; at iteration end we
  // apply (accumulated correction / degree) to each node, then loop.
  // The degree normalisation keeps the per-node move bounded: with K
  // constraints all pulling the same direction, the accumulator is
  // K·half but we apply K·half/K = half — i.e. same magnitude as if
  // there were just one constraint. Without normalisation, dense
  // graphs would massively overshoot.
  let accDx = new Float32Array(0);
  let accDy = new Float32Array(0);
  let accDz = new Float32Array(0);
  // Sum of per-pair WEIGHTS touching each node (not just count of
  // constraints) — the divisor in the weighted-average correction.
  let accW  = new Float32Array(0);
  function force(_simAlpha) {
    const n = nodes.length;
    if (n === 0) return;
    const baseD = getBaseDist();
    const cit   = getHasCit();
    if (!baseD || !cit) return;
    // baseD / cit are sized nData × nData (data nodes only). The
    // simulation may include extra debug gizmo nodes (origins,
    // centroids); those are not in the pair tables, so we skip them
    // and index by data-node id with stride = sqrt(baseD.length).
    const stride = Math.sqrt(baseD.length) | 0;
    const A = +getAlpha() || 0;
    // Rest factor goes 1 → 0 monotonically as α: 0 → ALPHA_MAX.
    const restFactor = Math.max(0, 1 - A / ALPHA_MAX);
    // Cited weight grows linearly with α so cited constraints win the
    // shared-node tug-of-war more aggressively as α rises.
    const citedWeight = 1 + A;

    if (accDx.length < n) {
      accDx = new Float32Array(n);
      accDy = new Float32Array(n);
      accDz = new Float32Array(n);
      accW  = new Float32Array(n);
    }

    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < n; i++) { accDx[i] = 0; accDy[i] = 0; accDz[i] = 0; accW[i] = 0; }

      for (let i = 0; i < n; i++) {
        const ni = nodes[i];
        if (ni.kind && ni.kind !== "node") continue;
        const idi = ni.id;
        for (let j = i + 1; j < n; j++) {
          const nj = nodes[j];
          if (nj.kind && nj.kind !== "node") continue;
          const idj = nj.id;
          const semRest = baseD[idi * stride + idj];
          const cited   = cit[idi * stride + idj];
          const rest    = cited ? restFactor * semRest : semRest;
          const w       = cited ? citedWeight : 1;

          const dx = nj.x - ni.x, dy = nj.y - ni.y, dz = nj.z - ni.z;
          const d = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1e-6;
          const half = stiffness * (d - rest) * 0.5;
          const wHalfUx = w * half * dx / d;
          const wHalfUy = w * half * dy / d;
          const wHalfUz = w * half * dz / d;
          accDx[i] += wHalfUx; accDy[i] += wHalfUy; accDz[i] += wHalfUz;
          accDx[j] -= wHalfUx; accDy[j] -= wHalfUy; accDz[j] -= wHalfUz;
          accW[i]  += w;       accW[j]  += w;
        }
      }

      for (let i = 0; i < n; i++) {
        const ni = nodes[i];
        if (ni.kind && ni.kind !== "node") continue;
        const wsum = accW[i];
        if (wsum <= 0) continue;
        const inv = 1 / wsum;
        ni.x += accDx[i] * inv;
        ni.y += accDy[i] * inv;
        ni.z += accDz[i] * inv;
      }
    }

    // Kabsch alignment pass. Distance constraints are rigid-body
    // invariant: any rotation+translation of an equilibrium is also an
    // equilibrium. Without an explicit orientation reference, the
    // network drifts rigidly during α changes (each new equilibrium is
    // chosen by initial conditions, including any tiny numerical
    // noise). The user perceives this as the camera spinning. We pin
    // orientation by computing the optimal rotation that aligns current
    // live positions with basePos and applying its inverse — the non-
    // rigid deformation (which IS what α should produce) is preserved,
    // only rigid drift is removed.
    if (getBasePos) {
      const bp = getBasePos();
      if (bp && bp.length >= stride * 3) {
        kabschAlign(nodes, bp, stride);
      }
    }
  }
  force.initialize = function (_nodes) { nodes = _nodes; };
  return force;
}

// In-place rigid alignment of `nodes`' live positions to `bp` (basePos
// flat array, 3 floats per data-node id, indexed by node.id). Computes
// the optimal rotation R + translation t (Horn's quaternion-based
// closed form, Jacobi eigendecomposition of the 4×4 cross-covariance
// matrix) that maps basePos → live, then applies (R⁻¹, −t) to live so
// the network ends up oriented like basePos.
function kabschAlign(nodes, bp, stride) {
  // Pass 1: centroids over data-node entries only.
  let cx = 0, cy = 0, cz = 0, bcx = 0, bcy = 0, bcz = 0, count = 0;
  for (const ni of nodes) {
    if (ni.kind && ni.kind !== "node") continue;
    const id = ni.id;
    if (id < 0 || id >= stride) continue;
    cx += ni.x; cy += ni.y; cz += ni.z;
    bcx += bp[id*3]; bcy += bp[id*3+1]; bcz += bp[id*3+2];
    count++;
  }
  if (count < 3) return;          // can't define orientation from < 3 points
  cx /= count; cy /= count; cz /= count;
  bcx /= count; bcy /= count; bcz /= count;

  // Pass 2: cross-correlation S = Σ a · bᵀ, a = bp−bc, b = live−c.
  let Sxx=0,Sxy=0,Sxz=0,Syx=0,Syy=0,Syz=0,Szx=0,Szy=0,Szz=0;
  for (const ni of nodes) {
    if (ni.kind && ni.kind !== "node") continue;
    const id = ni.id;
    if (id < 0 || id >= stride) continue;
    const ax = bp[id*3]   - bcx, ay = bp[id*3+1] - bcy, az = bp[id*3+2] - bcz;
    const bx = ni.x - cx, by = ni.y - cy, bz = ni.z - cz;
    Sxx += ax*bx; Sxy += ax*by; Sxz += ax*bz;
    Syx += ay*bx; Syy += ay*by; Syz += ay*bz;
    Szx += az*bx; Szy += az*by; Szz += az*bz;
  }

  // Horn's symmetric 4×4 N matrix. Eigenvector of largest eigenvalue
  // gives the unit quaternion (qw, qx, qy, qz) of the rotation that
  // maps a (basePos centred) → b (live centred).
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

  // Build R (basePos → live) from the quaternion.
  const r00 = 1 - 2*qy*qy - 2*qz*qz;
  const r01 = 2*qx*qy - 2*qw*qz;
  const r02 = 2*qx*qz + 2*qw*qy;
  const r10 = 2*qx*qy + 2*qw*qz;
  const r11 = 1 - 2*qx*qx - 2*qz*qz;
  const r12 = 2*qy*qz - 2*qw*qx;
  const r20 = 2*qx*qz - 2*qw*qy;
  const r21 = 2*qy*qz + 2*qw*qx;
  const r22 = 1 - 2*qx*qx - 2*qy*qy;

  // We want to map live → "live in basePos's frame" by applying R⁻¹
  // (which for an orthogonal matrix is Rᵀ). For each node:
  //   live_aligned = Rᵀ · (live − c) + bc
  // i.e. shift live to its centroid, rotate by Rᵀ, place at basePos
  // centroid. The non-rigid residual within is preserved; only the
  // rigid drift is removed.
  for (const ni of nodes) {
    if (ni.kind && ni.kind !== "node") continue;
    const id = ni.id;
    if (id < 0 || id >= stride) continue;
    const dx = ni.x - cx, dy = ni.y - cy, dz = ni.z - cz;
    // Rᵀ rows are R columns.
    ni.x = r00*dx + r10*dy + r20*dz + bcx;
    ni.y = r01*dx + r11*dy + r21*dz + bcy;
    ni.z = r02*dx + r12*dy + r22*dz + bcz;
  }
}

// Cyclic Jacobi eigendecomposition for a symmetric 4×4 matrix. Same
// implementation as physics-debug.js (kept local here so the solver
// has no dependency on debug code). Returns {eigvals, V} where V is
// row-major; column j is the eigenvector for eigvals[j].
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
