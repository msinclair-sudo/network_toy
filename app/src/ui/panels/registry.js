// Panel registry. Each entry exposes:
//   { id, label, description, mount(container, state, config) }
//
// `mount` returns a panel instance: { update(state), destroy() }
//
// New panel types slot in here as one entry — same pattern as
// clustering / citation-layout registries on the engine side.

import * as Placeholder            from "./placeholder.js";
import * as Viewer3D               from "./viewer-3d.js";
import * as Viewer2D               from "./viewer-2d.js";
import * as NodeTable              from "./node-table.js";
import * as ValidationRunOptimise  from "./validation-run-optimise.js";
import * as MethodReceipt          from "./method-receipt.js";
import * as BootstrapStability     from "./bootstrap-stability.js";
import * as BridgeAnalysis         from "./bridge-analysis.js";
import * as DimSweep               from "./dim-sweep.js";
import * as FusionComparison       from "./fusion-comparison.js";
import * as NextSteps              from "./next-steps.js";

const entries = new Map();

function register(mod) {
  entries.set(mod.ID, {
    id:          mod.ID,
    label:       mod.LABEL || mod.ID,
    description: mod.DESCRIPTION || "",
    mount:       mod.mount,
    singleton:   !!mod.SINGLETON,    // panel-picker filters singletons already mounted
    // §6.19.2 — panels that render a specific saved run aren't useful
    // as "add a blank one" choices in the picker; they're meant to be
    // instantiated bound to a runId. The picker filters these out of
    // its main type list and surfaces saved runs in a separate
    // "Validation runs" section instead.
    hideFromTypeList: !!mod.HIDE_FROM_TYPE_LIST,
  });
}

register(Placeholder);
register(Viewer3D);
register(Viewer2D);
register(NodeTable);
register(ValidationRunOptimise);
register(MethodReceipt);
register(BootstrapStability);
register(BridgeAnalysis);
register(DimSweep);
register(FusionComparison);
register(NextSteps);

// Future entries (mounted as their modules come online):
// register(await import("./cluster-tree.js"));
// register(await import("./paper-table.js"));
// register(await import("./histogram.js"));
// register(await import("./heatmap.js"));

export function getPanelType(id) {
  return entries.get(id) || entries.get("placeholder");
}

export function listPanelTypes() {
  return [...entries.values()];
}
