// Panel system — multi-tab edition.
//
// Each slot (primary / secondary / bottom) holds an array of tabs;
// one is active at a time. Tab strip shows one tab per entry, plus
// a "+" button at the end for adding new ones via the panel-picker
// modal. Each tab has a small "×" close button.
//
// State coupling:
//   state.panels[slot] = { activeTabId, tabs: [{ id, type, config }] }
//
// Panel module contract:
//   mount(container, state, config, tabContext) → { update(state), destroy() }
// where tabContext = { slot, tabId } so panels can persist their own
// config (e.g. viewer-3d's camera settings).

import { getState, subscribe, addTab, closeTab, setActiveTab } from "./state.js";
import { getPanelType, listPanelTypes }                       from "./panels/registry.js";
import { openPanelPickerModal }                               from "./modals/panel-picker.js";

const SLOTS = ["primary", "secondary", "bottom"];

// Per-slot tracking. panelsRef lets us skip tab-strip rebuilds when
// only state.blend (or other unrelated slices) changed.
const slotInstances = new Map();   // slot → { panelsRef, instance, tabId }

export function mountPanelSystem() {
  for (const slot of SLOTS) initSlot(slot);

  subscribe((state) => {
    for (const slot of SLOTS) {
      const slotEl = document.querySelector(`.panel-slot[data-slot="${slot}"]`);
      if (!slotEl) continue;
      const desired = state.panels[slot];
      const tracked = slotInstances.get(slot);

      // Tabs / active changed → re-render strip and possibly remount.
      if (!tracked || tracked.panelsRef !== desired) {
        renderTabs(slot, slotEl);
        if (!tracked || tracked.tabId !== desired.activeTabId) {
          renderActivePanel(slot, slotEl);
        }
      }

      // Always deliver fresh state to the active instance.
      const t = slotInstances.get(slot);
      if (t && t.instance && t.instance.update) {
        try { t.instance.update(state); }
        catch (e) { console.error("[panel-system] panel update threw:", e); }
      }
    }
  });
}

function initSlot(slot) {
  const slotEl = document.querySelector(`.panel-slot[data-slot="${slot}"]`);
  if (!slotEl) return;
  renderTabs(slot, slotEl);
  renderActivePanel(slot, slotEl);
}

function renderTabs(slot, slotEl) {
  const tabsEl = slotEl.querySelector(".panel-tabs");
  if (!tabsEl) return;
  const slotState = getState().panels[slot];

  tabsEl.innerHTML = "";

  // One tab per entry, with × close button.
  for (const tab of slotState.tabs) {
    const meta = getPanelType(tab.type);
    const tabEl = document.createElement("div");
    tabEl.className = "panel-tab" + (tab.id === slotState.activeTabId ? " active" : "");
    tabEl.title = meta.description || meta.label || "";

    const label = document.createElement("span");
    label.className = "panel-tab-label";
    label.textContent = meta.label || tab.type;
    label.addEventListener("click", () => setActiveTab(slot, tab.id));
    tabEl.appendChild(label);

    const closeBtn = document.createElement("span");
    closeBtn.className = "panel-tab-close";
    closeBtn.title = "Close tab";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(slot, tab.id);
    });
    tabEl.appendChild(closeBtn);

    tabsEl.appendChild(tabEl);
  }

  // "+" button at the end of the actual tabs.
  const addBtn = document.createElement("div");
  addBtn.className = "panel-tab-add";
  addBtn.title = "Add panel…";
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => {
    openPanelPickerModal(slot, (typeId) => {
      addTab(slot, typeId, defaultConfigFor(typeId));
    });
  });
  tabsEl.appendChild(addBtn);

  // Spacer + slot-name label on the right.
  const spacer = document.createElement("div");
  spacer.className = "panel-tab-spacer";
  spacer.style.flex = "1";
  tabsEl.appendChild(spacer);

  const slotLabel = document.createElement("div");
  slotLabel.className = "panel-tab slot-name";
  slotLabel.style.color = "var(--text-faint)";
  slotLabel.style.cursor = "default";
  slotLabel.textContent = slot;
  tabsEl.appendChild(slotLabel);
}

function renderActivePanel(slot, slotEl) {
  const contentEl = slotEl.querySelector(".panel-content");
  if (!contentEl) return;
  const slotState = getState().panels[slot];

  // Tear down previous instance for this slot.
  const prev = slotInstances.get(slot);
  if (prev && prev.instance && prev.instance.destroy) {
    try { prev.instance.destroy(); } catch (e) { console.warn(e); }
  }
  contentEl.innerHTML = "";

  // No active tab → empty hint.
  if (!slotState.activeTabId || slotState.tabs.length === 0) {
    contentEl.appendChild(emptySlotHint());
    slotInstances.set(slot, { panelsRef: slotState, instance: null, tabId: null });
    return;
  }

  const tab = slotState.tabs.find(t => t.id === slotState.activeTabId);
  if (!tab) {
    slotInstances.set(slot, { panelsRef: slotState, instance: null, tabId: null });
    return;
  }

  const meta = getPanelType(tab.type);
  const tabContext = { slot, tabId: tab.id };

  // Pre-register the slot tracker BEFORE mount so any state writes
  // made during mount (e.g. colour-mode migration → setTabConfig)
  // re-entering the subscribe see `tracked.tabId === desired.activeTabId`
  // and skip re-running renderActivePanel — otherwise we recurse,
  // destroying the half-built panel and leaving orphan DOM overlays.
  slotInstances.set(slot, { panelsRef: slotState, instance: null, tabId: tab.id });

  let instance = null;
  try {
    instance = meta.mount(contentEl, getState(), tab.config || {}, tabContext);
  } catch (e) {
    console.error(`[panel-system] failed to mount ${tab.type}:`, e);
    contentEl.innerHTML = "";
    contentEl.appendChild(errorPlaceholder(tab.type, e));
  }
  slotInstances.set(slot, { panelsRef: slotState, instance, tabId: tab.id });
}

function emptySlotHint() {
  const root = document.createElement("div");
  root.className = "placeholder-panel";
  const title = document.createElement("div");
  title.className = "placeholder-title";
  title.textContent = "No panel";
  const hint = document.createElement("div");
  hint.className = "placeholder-hint";
  hint.innerHTML = "Click <strong>+</strong> in the tab bar to add one.";
  root.appendChild(title);
  root.appendChild(hint);
  return root;
}

function errorPlaceholder(type, err) {
  const root = document.createElement("div");
  root.className = "placeholder-panel";
  const title = document.createElement("div");
  title.className = "placeholder-title";
  title.textContent = `Failed to mount: ${type}`;
  const hint = document.createElement("div");
  hint.className = "placeholder-hint";
  hint.style.color = "var(--err)";
  hint.textContent = String(err && err.message ? err.message : err);
  root.appendChild(title);
  root.appendChild(hint);
  return root;
}

// Default configs for a freshly-added tab. Centralised so picking
// "viewer-3d" from the +-modal seeds it with sensible camera speeds
// rather than empty {}.
function defaultConfigFor(typeId) {
  switch (typeId) {
    case "viewer-3d":
      return {
        rotateSpeed: 0.3, zoomSpeed: 0.3, panSpeed: 0.3, smoothMotion: false,
        colourMode:  "cluster:finest",
      };
    default:
      return {};
  }
}
