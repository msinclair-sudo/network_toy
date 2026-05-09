// Panel system. Each slot (primary / secondary / bottom) hosts
// one active panel at a time. Tab strip at the top lets the user
// switch panel types; "+" opens a menu of registered panel types.
//
// Each slot DOM container is in index.html — we mount tabs into
// `.panel-tabs` and the panel into `.panel-content`.
//
// State coupling:
//   state.panels[slot] = { type, config }
// Switching the type swaps which panel is mounted; config is
// passed to the panel's mount().

import { getState, subscribe, setPanel } from "./state.js";
import { getPanelType, listPanelTypes } from "./panels/registry.js";

const SLOTS = ["primary", "secondary", "bottom"];

const slotInstances = new Map();   // slot → { instance, type }

export function mountPanelSystem() {
  for (const slot of SLOTS) {
    const slotEl = document.querySelector(`.panel-slot[data-slot="${slot}"]`);
    if (!slotEl) continue;
    renderTabs(slot, slotEl);
    renderActivePanel(slot, slotEl);
  }

  subscribe((state) => {
    for (const slot of SLOTS) {
      const slotEl = document.querySelector(`.panel-slot[data-slot="${slot}"]`);
      if (!slotEl) continue;
      const current = slotInstances.get(slot);
      const desired = state.panels[slot];
      // Re-mount when panel type changes.
      if (!current || current.type !== desired.type) {
        renderActivePanel(slot, slotEl);
        renderTabs(slot, slotEl);
      } else if (current.instance && current.instance.update) {
        current.instance.update(state);
      }
    }
  });
}

function renderTabs(slot, slotEl) {
  const tabsEl = slotEl.querySelector(".panel-tabs");
  if (!tabsEl) return;
  const state = getState();
  const activeType = state.panels[slot].type;

  tabsEl.innerHTML = "";

  // Single active-type indicator + dropdown to swap.
  // (Multi-tab windowing is future work; for now one panel per slot.)
  const tab = document.createElement("div");
  tab.className = "panel-tab active";
  const typeMeta = getPanelType(activeType);
  tab.textContent = typeMeta.label || activeType;
  tab.title = typeMeta.description || "";
  tab.addEventListener("click", () => openPanelTypeMenu(slot, tab));
  tabsEl.appendChild(tab);

  // "+" doesn't add a new tab in this slice — it's a hint that
  // multi-tab windowing is planned.
  const spacer = document.createElement("div");
  spacer.className = "panel-tab-spacer";
  spacer.style.flex = "1";
  tabsEl.appendChild(spacer);

  const slotLabel = document.createElement("div");
  slotLabel.className = "panel-tab";
  slotLabel.style.color = "var(--text-faint)";
  slotLabel.style.cursor = "default";
  slotLabel.textContent = slot;
  tabsEl.appendChild(slotLabel);
}

function renderActivePanel(slot, slotEl) {
  const contentEl = slotEl.querySelector(".panel-content");
  if (!contentEl) return;
  const state = getState();
  const { type, config } = state.panels[slot];

  // Tear down previous instance for this slot.
  const prev = slotInstances.get(slot);
  if (prev && prev.instance && prev.instance.destroy) {
    try { prev.instance.destroy(); } catch (e) { console.warn(e); }
  }

  const meta = getPanelType(type);
  const instance = meta.mount(contentEl, state, config || {});
  slotInstances.set(slot, { instance, type });
}

// Inline dropdown listing every registered panel type.
function openPanelTypeMenu(slot, anchor) {
  // Tear down any existing menu.
  document.querySelectorAll(".panel-type-menu").forEach(el => el.remove());

  const menu = document.createElement("div");
  menu.className = "topbar-menu-dropdown panel-type-menu";
  menu.style.display = "block";
  menu.style.position = "fixed";

  const rect = anchor.getBoundingClientRect();
  menu.style.top  = `${rect.bottom}px`;
  menu.style.left = `${rect.left}px`;

  for (const t of listPanelTypes()) {
    const item = document.createElement("div");
    item.className = "topbar-menu-item";
    item.textContent = t.label;
    item.title = t.description;
    item.addEventListener("click", () => {
      setPanel(slot, t.id, {
        label: t.label,
        hint:  t.description || `${t.label} panel`,
      });
      menu.remove();
    });
    menu.appendChild(item);
  }

  document.body.appendChild(menu);

  // Click-outside to close.
  setTimeout(() => {
    const closer = (e) => {
      if (!menu.contains(e.target)) {
        menu.remove();
        document.removeEventListener("click", closer, true);
      }
    };
    document.addEventListener("click", closer, true);
  }, 0);
}
