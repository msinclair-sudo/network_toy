// Panel registry. Each entry exposes:
//   { id, label, description, mount(container, state, config) }
//
// `mount` returns a panel instance: { update(state), destroy() }
//
// New panel types slot in here as one entry — same pattern as
// clustering / citation-layout registries on the engine side.

import * as Placeholder from "./placeholder.js";
import * as Viewer3D    from "./viewer-3d.js";

const entries = new Map();

function register(mod) {
  entries.set(mod.ID, {
    id:          mod.ID,
    label:       mod.LABEL || mod.ID,
    description: mod.DESCRIPTION || "",
    mount:       mod.mount,
  });
}

register(Placeholder);
register(Viewer3D);

// Future entries (mounted as their modules come online):
// register(await import("./cluster-table.js"));    // slice 3
// register(await import("./viewer-2d.js"));        // slice 6
// register(await import("./cluster-tree.js"));     // slice 6
// register(await import("./paper-table.js"));      // slice 6
// register(await import("./histogram.js"));        // slice 6
// register(await import("./heatmap.js"));          // slice 6

export function getPanelType(id) {
  return entries.get(id) || entries.get("placeholder");
}

export function listPanelTypes() {
  return [...entries.values()];
}
