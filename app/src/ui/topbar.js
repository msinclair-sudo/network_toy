// Topbar — menu strip at the top of the window.
//
// Menus per doc/ui.md §3:
//   Data ▾   Workflow ▾   Validate ▾   Help ▾
// plus a global seed input.
//
// Most menu items open modals; in this slice they're stubs
// (console.log placeholder). Modals get built in slice 5.

import { getState, subscribe, setToyParam } from "./state.js";

const MENUS = [
  {
    id: "data",
    label: "Data",
    items: [
      { label: "New toy dataset…",     action: stub("data:new-toy") },
      { label: "Load real dataset…",   action: stub("data:load-real"), disabled: true },
      { label: "Citation source…",     action: stub("data:citation-source") },
      { divider: true },
      { label: "Save state…",          action: stub("data:save"), disabled: true },
      { label: "Export labels…",       action: stub("data:export-labels"), disabled: true },
      { label: "Export edges…",        action: stub("data:export-edges"), disabled: true },
    ],
  },
  {
    id: "workflow",
    label: "Workflow",
    items: [
      { label: "Reset to defaults",    action: stub("workflow:reset") },
      { label: "Save preset…",         action: stub("workflow:save-preset"), disabled: true },
      { label: "Load preset…",         action: stub("workflow:load-preset"), disabled: true },
    ],
  },
  {
    id: "validate",
    label: "Validate",
    items: [
      { label: "Bootstrap-Jaccard stability…",     action: stub("validate:bootstrap"), disabled: true },
      { label: "ARI dim-sweep…",                    action: stub("validate:ari-sweep"), disabled: true },
      { label: "Cluster-vs-cluster disagreement…",  action: stub("validate:disagreement"), disabled: true },
    ],
  },
  {
    id: "help",
    label: "Help",
    items: [
      { label: "About",                action: stub("help:about") },
      { label: "Method manual",        action: stub("help:manual"), disabled: true },
      { label: "Keyboard shortcuts",   action: stub("help:shortcuts"), disabled: true },
    ],
  },
];

export function mountTopbar() {
  const root = document.getElementById("topbar");
  if (!root) return;
  root.innerHTML = "";

  for (const menu of MENUS) {
    root.appendChild(renderMenu(menu));
  }

  const spacer = document.createElement("div");
  spacer.className = "topbar-spacer";
  root.appendChild(spacer);

  root.appendChild(renderSeed());

  // Click-outside handler closes any open menu.
  document.addEventListener("click", (e) => {
    if (!root.contains(e.target)) closeAllMenus();
  });
}

function renderMenu(menu) {
  const wrap = document.createElement("div");
  wrap.className = "topbar-menu";
  wrap.dataset.menuId = menu.id;

  const label = document.createElement("span");
  label.textContent = `${menu.label} ▾`;
  wrap.appendChild(label);

  const dropdown = document.createElement("div");
  dropdown.className = "topbar-menu-dropdown";

  for (const item of menu.items) {
    if (item.divider) {
      const div = document.createElement("div");
      div.className = "topbar-menu-divider";
      dropdown.appendChild(div);
      continue;
    }
    const el = document.createElement("div");
    el.className = "topbar-menu-item" + (item.disabled ? " disabled" : "");
    el.textContent = item.label;
    if (!item.disabled) {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        closeAllMenus();
        try { item.action(); } catch (err) { console.error(err); }
      });
    }
    dropdown.appendChild(el);
  }

  wrap.appendChild(dropdown);

  wrap.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = wrap.classList.contains("open");
    closeAllMenus();
    if (!wasOpen) wrap.classList.add("open");
  });

  return wrap;
}

function closeAllMenus() {
  document.querySelectorAll("#topbar .topbar-menu.open").forEach((el) => {
    el.classList.remove("open");
  });
}

function renderSeed() {
  const wrap = document.createElement("div");
  wrap.className = "topbar-seed";

  const label = document.createElement("span");
  label.textContent = "seed:";
  wrap.appendChild(label);

  const input = document.createElement("input");
  input.type = "number";
  input.value = String(getState().dataSource.config.seed);
  input.addEventListener("change", (e) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v)) setToyParam("seed", v);
  });
  wrap.appendChild(input);

  // Keep seed input in sync if state changes elsewhere.
  subscribe((state) => {
    const v = String(state.dataSource.config.seed);
    if (input.value !== v) input.value = v;
  });

  return wrap;
}

function stub(id) {
  return () => {
    console.log(`[topbar action stub] ${id}`);
    // Once modals are built (slice 5), each action opens its modal here.
  };
}
