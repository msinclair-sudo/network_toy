// Per-frame layout blend.
//
// The α=0 endpoint is basePos (the generation-seed Gaussian-mixture
// cloud). The α=1 endpoint is alignedCitationPos (the FR layout,
// per-component-aligned to basePos by ./align.js). Each frame the
// live position of every data node is the linear interpolation:
//
//   live_i = (1 − α) · basePos_i  +  α · alignedCitationPos_i
//
// No state, no constraint solver, no momentum. Slider drives the
// blend directly; the network is a deterministic function of α.
//
// Registered as a d3-force-3d "force" hook so it runs every tick of
// the lib's animation loop. With d3VelocityDecay = 1.0 (set by
// main.js) the lib's integration `x += vx; vx *= 0` becomes a no-op,
// so this hook owns position entirely.

export function makeBlendForce({
  getBasePos,
  getAlignedCitationPos,
  getBlend,
} = {}) {
  let nodes = [];
  function force(_simAlpha) {
    const n = nodes.length;
    if (n === 0) return;
    const bp = getBasePos();
    const cp = getAlignedCitationPos();
    if (!bp || !cp) return;
    const stride = bp.length / 3;
    let a = +getBlend() || 0;
    if (a < 0) a = 0;
    else if (a > 1) a = 1;
    const oneMinusA = 1 - a;

    for (let i = 0; i < n; i++) {
      const ni = nodes[i];
      // Skip debug-only nodes (origins, centroids); they're pinned via
      // fx/fy/fz by the lib, and they're not in the basePos table
      // anyway (basePos is sized to data nodes only).
      if (ni.kind && ni.kind !== "node") continue;
      const id = ni.id;
      if (id < 0 || id >= stride) continue;
      ni.x = oneMinusA * bp[id*3]   + a * cp[id*3];
      ni.y = oneMinusA * bp[id*3+1] + a * cp[id*3+1];
      ni.z = oneMinusA * bp[id*3+2] + a * cp[id*3+2];
    }
  }
  force.initialize = function (_nodes) { nodes = _nodes; };
  return force;
}
