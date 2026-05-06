// Physics debug — overlays for the hybrid spring force.
//
// Two visual modes (independent, both togglable):
//   - tensionCitations: colour citation edges by the live (d − ℓ) / d of
//     their spring. Stretched → warm, compressed → cool, neutral → grey.
//   - tensionBase: same idea but for base edges. Useful to see how the
//     network of "uncited" springs absorbs the deformation as α rises.
//
// Tension is read from the float32 cache the force writes every tick. The
// per-link material-clone hook in main.js calls `colourForTension` once
// per frame for matching link kinds.

export const physicsDebugFlags = {
  tensionCitations: false,
  tensionBase: false,
};

// Map normalised tension t ∈ [-1, 1] to a colour.
//   t = 0    → neutral grey
//   t > 0    → red (stretched)
//   t < 0    → blue (compressed)
// Linear interpolation in RGB space, clamped.
const NEUTRAL = [180, 180, 190];
const STRETCH = [255,  90,  60];
const COMPRESS= [ 70, 170, 255];
export function colourForTension(t) {
  if (!isFinite(t)) return rgb(NEUTRAL);
  if (t === 0) return rgb(NEUTRAL);
  const target = t > 0 ? STRETCH : COMPRESS;
  const m = Math.min(1, Math.abs(t));
  return rgb([
    Math.round(NEUTRAL[0] + (target[0] - NEUTRAL[0]) * m),
    Math.round(NEUTRAL[1] + (target[1] - NEUTRAL[1]) * m),
    Math.round(NEUTRAL[2] + (target[2] - NEUTRAL[2]) * m),
  ]);
}
function rgb([r, g, b]) {
  return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
}
