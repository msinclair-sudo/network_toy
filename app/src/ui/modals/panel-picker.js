// Panel-picker modal: shown when the user clicks the "+" tab in any
// slot. Lists every registered panel type (except the placeholder)
// as a clickable card; on pick, calls `onPick(typeId)` and closes.
//
// Pattern is generic — any slot uses the same modal; the slot label
// just shows in the title.

import { openModal }        from "./modal.js";
import { listPanelTypes }   from "../panels/registry.js";
import { getState }         from "../state.js";

// Hide singletons that already have a tab anywhere in panels.
function isSingletonAlreadyMounted(typeId) {
  const panels = getState().panels;
  for (const slot of Object.keys(panels)) {
    for (const tab of panels[slot].tabs) {
      if (tab.type === typeId) return true;
    }
  }
  return false;
}

export function openPanelPickerModal(slot, onPick) {
  const body = document.createElement("div");
  body.className = "panel-picker-list";

  let modal = null;

  const types = listPanelTypes()
    .filter(t => t.id !== "placeholder")
    .filter(t => !(t.singleton && isSingletonAlreadyMounted(t.id)));
  if (types.length === 0) {
    const empty = document.createElement("div");
    empty.className = "panel-picker-empty";
    empty.textContent = "No panel types registered.";
    body.appendChild(empty);
  } else {
    for (const t of types) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "panel-picker-item";

      const label = document.createElement("div");
      label.className = "panel-picker-item-label";
      label.textContent = t.label;
      item.appendChild(label);

      if (t.description) {
        const desc = document.createElement("div");
        desc.className = "panel-picker-item-desc";
        desc.textContent = t.description;
        item.appendChild(desc);
      }

      item.addEventListener("click", () => {
        try { onPick(t.id); }
        catch (e) { console.error("[panel-picker] onPick failed:", e); }
        if (modal) modal.close();
      });
      body.appendChild(item);
    }
  }

  modal = openModal({
    title: `Add panel — ${slot}`,
    body,
    actions: [
      { label: "Cancel" },
    ],
  });

  return modal;
}
