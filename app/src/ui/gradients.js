// Shared gradient colour functions.
//
// viewer-3d uses these to colour nodes; node-table uses the same
// definitions to colour swatches + the legend bar so the table truly
// reads as the legend for what's on screen. If a gradient changes
// here, both the viewer and the legend track automatically.
//
// Each gradient is a list of [t, [r,g,b]] stops. interp() maps
// t ∈ [0, 1] to a CSS rgb(...) string by linear interpolation.

export const T_STOPS = [
  [0.00, [97, 175, 239]],     // accent blue (cool)
  [0.50, [191, 188, 168]],    // muted middle
  [1.00, [242, 142, 43]],     // warm orange
];

export const INDEG_STOPS = [
  [0.00, [80, 90, 110]],      // faint slate (no citations)
  [1.00, [97, 175, 239]],     // bright accent (max in-degree)
];

export const BOUNDARY_STOPS = [
  [0.00, [58, 63, 74]],       // pure interior
  [0.50, [180, 130, 80]],
  [1.00, [230, 108, 117]],    // perfect mixing
];

export function tGradient(t)              { return interp(T_STOPS, t); }
export function inDegGradient(t)          { return interp(INDEG_STOPS, t); }
export function boundaryScoreGradient(t)  { return interp(BOUNDARY_STOPS, t); }

function interp(stops, t) {
  const v = Math.max(0, Math.min(1, +t || 0));
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const f = (v - t0) / Math.max(1e-9, t1 - t0);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * f);
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  const last = stops[stops.length - 1][1];
  return `rgb(${last[0]}, ${last[1]}, ${last[2]})`;
}

// Render a CSS linear-gradient string for a stops array; useful for
// the legend bar.
export function cssLinearGradient(stops) {
  return "linear-gradient(to right, " + stops.map(([t, [r, g, b]]) =>
    `rgb(${r}, ${g}, ${b}) ${(t * 100).toFixed(0)}%`
  ).join(", ") + ")";
}
