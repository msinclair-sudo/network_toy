// Multi-level clustering modal — tabbed surface for everything
// cluster-related. Three tabs:
//
//   Configure  — pick algorithm + edit per-level params (existing).
//   Optimise   — sweep configs, rank by stability or ARI, apply a row.
//   Validate   — bootstrap-Jaccard the currently-applied clustering.
//
// The Configure / Apply pair is the "configuration commit" path —
// Apply commits the working levels editor and triggers recluster.
// Optimise's per-row Apply hops the user to the Validate tab so the
// natural workflow is Configure → Optimise → Validate. Tabs can also
// be visited freely; visit order is not enforced.

import { openModal } from "./modal.js";
import { buildConfigureTab } from "./clustering-tabs/configure-tab.js";
import { buildOptimiseTab }  from "./clustering-tabs/optimise-tab.js";
import { buildValidateTab }  from "./clustering-tabs/validate-tab.js";

const TABS = [
  { id: "configure", label: "Configure" },
  { id: "optimise",  label: "Optimise"  },
  { id: "validate",  label: "Validate"  },
];

export function openClusteringModal(descriptor) {
  // Per-tab handles, populated lazily on first activation.
  const tabHandles = {};

  // Body shell.
  const body = document.createElement("div");
  body.className = "clustering-modal-body";

  const tabStrip = document.createElement("div");
  tabStrip.className = "modal-tab-strip";
  body.appendChild(tabStrip);

  const tabPanes = document.createElement("div");
  tabPanes.className = "modal-tab-panes";
  body.appendChild(tabPanes);

  const paneEls = {};
  for (const t of TABS) {
    const pane = document.createElement("div");
    pane.className = "modal-tab-pane";
    pane.dataset.tabId = t.id;
    pane.style.display = "none";
    tabPanes.appendChild(pane);
    paneEls[t.id] = pane;
  }

  let activeTab = "configure";

  function setActiveTab(tabId) {
    if (!paneEls[tabId]) return;
    // Notify the previously-active tab so it can cancel in-flight work.
    if (tabHandles[activeTab] && tabHandles[activeTab].onTabHidden) {
      try { tabHandles[activeTab].onTabHidden(); } catch (_) {}
    }
    activeTab = tabId;
    for (const t of TABS) {
      paneEls[t.id].style.display = (t.id === tabId) ? "" : "none";
    }
    rebuildTabStrip();
    // Lazily build the tab body the first time it's shown.
    if (!tabHandles[tabId]) {
      tabHandles[tabId] = buildTab(tabId, paneEls[tabId]);
    }
  }

  function rebuildTabStrip() {
    tabStrip.innerHTML = "";
    for (const t of TABS) {
      const tab = document.createElement("div");
      tab.className = "modal-tab" + (t.id === activeTab ? " active" : "");
      tab.textContent = t.label;
      tab.addEventListener("click", () => setActiveTab(t.id));
      tabStrip.appendChild(tab);
    }
  }

  function buildTab(tabId, host) {
    if (tabId === "configure") return buildConfigureTab(host, descriptor);
    if (tabId === "optimise") return buildOptimiseTab(host, {
      onApplyRow: (row) => {
        // Single-level commit. Optimise produced (algoId, params); we
        // wrap as a one-level config so Configure's working state
        // matches when the user hops back.
        const levels = [{
          uid:    Math.random().toString(36).slice(2, 10),
          params: { ...row.params },
          scope:  "global",
        }];
        // applyChange is async (descriptor → engine.recluster runs in
        // workers). Reflect into Configure first, hop to Validate to
        // park the user on a useful surface, then await the recluster
        // so Validate reads fresh clusters — not stale ones from before
        // the apply.
        if (tabHandles.configure && tabHandles.configure.overwrite) {
          tabHandles.configure.overwrite(row.algoId, levels);
        }
        setActiveTab("validate");
        Promise.resolve(descriptor.applyChange(row.algoId, levels)).catch(e => {
          console.error("[clustering-modal] onApplyRow applyChange failed:", e);
        });
      },
    });
    if (tabId === "validate") return buildValidateTab(host);
    return null;
  }

  // Initial state: Configure tab visible.
  rebuildTabStrip();
  paneEls.configure.style.display = "";
  tabHandles.configure = buildTab("configure", paneEls.configure);

  const modalHandle = openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Apply",
        primary: true,
        onClick: () => {
          // applyChange is async (descriptor → engine.recluster runs in
          // workers). Show Running… on the button + keep the modal open
          // until the cascade resolves so the user knows the click
          // registered. Mirrors the dimred-modal + algorithm-modal
          // pattern.
          startProgress(modalHandle);
          setTimeout(async () => {
            try {
              const w = tabHandles.configure && tabHandles.configure.getWorking();
              if (w) await descriptor.applyChange(w.algoId, w.levels);
            } catch (e) {
              console.error("[clustering-modal] applyChange failed:", e);
            }
            modalHandle.close();
          }, 30);
          return false;         // suppress default close-on-click
        },
      },
    ],
  });
  return modalHandle;
}

function startProgress(handle) {
  const btn = handle.dialog.querySelector(".modal-action.primary");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Running…";
  btn.classList.add("running");
}
