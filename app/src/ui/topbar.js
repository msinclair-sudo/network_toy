// Topbar — menu strip at the top of the window.
//
// Menus per doc/ui.md §3:
//   Data ▾   Workflow ▾   Validate ▾   Help ▾
// plus a global seed input.
//
// Most menu items open modals; in this slice they're stubs
// (console.log placeholder). Modals get built in slice 5.

import { getState, subscribe, setToyParam, setProjectName, update } from "./state.js";
import { serialiseState }   from "../persistence/serialise.js";
import { deserialiseFile }  from "../persistence/deserialise.js";
import { enqueueJob }       from "./queue.js";
import { createStep, getRootStep } from "./workflow.js";

const MENUS = [
  {
    id: "file",
    label: "File",
    items: [
      { label: "Save",          action: () => saveProject({ promptForName: false }) },
      { label: "Save as…",      action: () => saveProject({ promptForName: true }) },
      { label: "Load…",         action: () => loadProject() },
    ],
  },
  {
    id: "data",
    label: "Data",
    items: [
      { label: "New toy dataset…",     action: stub("data:new-toy") },
      { label: "Load real dataset…",   action: stub("data:load-real"), disabled: true },
      { label: "Citation source…",     action: stub("data:citation-source") },
      { divider: true },
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
      // Bootstrap-Jaccard lives inside the Clustering modal's Optimise
      // tab now (richness / stability scorers + target-range
      // runBootstrap). The remaining two items are legitimate future
      // work: ARI dim-sweep = §6.9; cluster-vs-cluster disagreement
      // is the §7 open question on a quantitative disagreement metric.
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
  // Seed is toy-only; real-data sources don't have one. setToyParam()
  // always targets the toy config regardless of active mode, so this
  // input keeps editing the toy generator's seed even while the user
  // is in real mode.
  input.value = String(getState().dataSource.configs.toy.seed);
  input.addEventListener("change", (e) => {
    const v = parseInt(e.target.value, 10);
    if (Number.isFinite(v)) setToyParam("seed", v);
  });
  wrap.appendChild(input);

  // Keep seed input in sync if state changes elsewhere.
  subscribe((state) => {
    const v = String(state.dataSource.configs.toy.seed);
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

/* ── File menu actions ─────────────────────────────────────────────── */

// "Save" reuses state.projectName (from the most-recent save / load).
// First save in a session goes through "Save as" since there's no
// remembered name yet.
function saveProject({ promptForName }) {
  const state = getState();
  let name = state.projectName;
  if (promptForName || !name) {
    const suggestion = name || defaultProjectName(state);
    const entered = window.prompt("Save project as:", suggestion);
    if (entered == null) return;          // user cancelled
    name = sanitiseProjectName(entered);
    if (!name) return;
    setProjectName(name);
  }

  // Phase 2 slice 2.9.c — save becomes a tree card under the root, so
  // the user's project history records every save. The card carries
  // {filename, sizeBytes, savedAt} as result. If the workflow has no
  // root yet (boot before migration), we fall back to a stepless job.
  const root = getRootStep();
  const label = `Save "${name}"`;
  let stepId = null;
  if (root) {
    try {
      stepId = createStep({
        type:    "save",
        label,
        params:  { filename: `${name}.zip` },
        parentId: root.id,
      });
    } catch (e) {
      console.warn("[topbar] createStep(save) failed; running stepless:", e);
      stepId = null;
    }
  }
  const { promise } = enqueueJob({
    type:  "save",
    label,
    stepId,
    fn:    async () => {
      let blob;
      try {
        blob = serialiseState(getState());
      } catch (e) {
        console.error("[topbar] save failed:", e);
        window.alert("Save failed — see browser console.");
        throw e;
      }
      triggerDownload(blob, `${name}.zip`);
      return {
        capturedAt: new Date().toISOString(),
        filename:   `${name}.zip`,
        sizeBytes:  blob.size,
        savedAt:    new Date().toISOString(),
      };
    },
  });
  promise.catch((e) => {
    if (e && e.name === "AbortError") return;
    console.error("[topbar] save job failed:", e);
  });
}

function loadProject() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,application/zip";
  input.style.display = "none";
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    // Phase 2 slice 2.9.c — load runs as a job. Card creation happens
    // AFTER deserialise + apply, because loading replaces state.workflow
    // wholesale; creating a card pre-load on the OUTGOING tree would be
    // wasted work. Post-load, we attach the load card to the LOADED
    // tree's root so the user's history records the import.
    const label = `Load "${file.name}"`;
    const { promise } = enqueueJob({
      type:  "load",
      label,
      stepId: null,    // can't bind: outgoing tree is about to be replaced
      fn:    async () => {
        let res;
        try {
          res = await deserialiseFile(file);
        } catch (e) {
          console.error("[topbar] load failed:", e);
          window.alert(`Load failed: ${e.message || e}`);
          throw e;
        }
        // Apply the patch wholesale — engine cascade is intentionally
        // skipped (we have all the results already; re-running would
        // overwrite them and defeat the point of saving). engineRevision
        // bumps so panels rebuild from the loaded data.
        const cur = getState();
        update({
          ...res.patch,
          clusterResult:  res.patch.clusterLevels && res.patch.clusterLevels.length
                           ? res.patch.clusterLevels[res.patch.clusterLevels.length - 1].clusterResult
                           : null,
          projectName:    res.patch.projectName || stripExtension(file.name),
          engineRevision: cur.engineRevision + 1,
        });
        console.log(`[topbar] loaded project '${file.name}' (saved ${res.manifest.savedAt})`);

        // Attach a load-history card to the loaded tree, if it has a
        // root. Best-effort — failure here doesn't undo the load.
        const root = getRootStep();
        if (root) {
          try {
            createStep({
              type:    "load",
              label,
              params:  { filename: file.name },
              parentId: root.id,
            });
          } catch (e) {
            console.warn("[topbar] createStep(load) failed (continuing):", e);
          }
        }

        return {
          capturedAt:      new Date().toISOString(),
          filename:        file.name,
          savedAtOriginal: res.manifest && res.manifest.savedAt,
          loadedAt:        new Date().toISOString(),
        };
      },
    });
    promise.catch((e) => {
      if (e && e.name === "AbortError") return;
      console.error("[topbar] load job failed:", e);
    });
  });
  document.body.appendChild(input);
  input.click();
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

function defaultProjectName(state) {
  const mode = state.dataSource && state.dataSource.mode;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `network-toy-${mode || "project"}-${stamp}`;
}

function sanitiseProjectName(s) {
  return String(s).trim().replace(/[\\/:*?"<>|]/g, "_");
}

function stripExtension(filename) {
  return filename.replace(/\.zip$/i, "");
}
