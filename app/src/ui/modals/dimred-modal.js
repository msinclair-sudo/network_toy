// Dim-reduction modal — three stacked sections.
//
// Layer 1.5 has three stages: noise reduction, dimension compression
// (clustering input), and visualisation reduction (viewer / blend
// input). Compression and viz are siblings — both fork off noise's
// output. The modal renders one section per stage, each section
// listing only registry entries whose family matches the slot (plus
// identity, which is "any" = "skip this stage").
//
// Descriptor shape (from layer-descriptors.js):
//   {
//     label:       string,
//     listAlgos:   (slot) => entries,
//     getActive:   () => { noise:{method,params}, compression:{...}, viz:{...} },
//     applyChange: ({ noise, compression, viz }) => void,
//   }
//
// Apply triggers descriptor.applyChange, which writes layerParams.dimred
// and re-runs engine.redimred(). Cancel discards the working copy.

import { openModal } from "./modal.js";

const SECTIONS = [
  {
    key: "noise",
    title: "Noise reduction",
    family: "noise",
    sub: "Denoiser stage; output feeds compression, 3D viz, and 2D viz.",
  },
  {
    key: "compression",
    title: "Dimension compression (clustering input)",
    family: "compression",
    sub: "Reduces noise output to the dim Layer 2 clusters in.",
  },
  {
    key: "viz",
    title: "3D visualisation reduction (3D viewer / blend)",
    family: "viz",
    sub: "Reduces noise output to 3-d for the 3D viewer + blend's α=0 endpoint. Pick UMAP-3 for real data; toy data already provides basePos.",
  },
  {
    key: "viz2d",
    title: "2D visualisation reduction (2D viewer)",
    family: "viz2d",
    sub: "Reduces noise output to 2-d for the 2D viewer panel. Independent of the 3D viz — different seed, different fit. The 2D panel stays empty until this produces a 2-d output.",
  },
];

export function openDimredModal(descriptor) {
  const active = descriptor.getActive();

  // Working copy — committed only on Apply. Each section keeps its own
  // (algoId, params) cursor.
  const working = {
    noise:       { method: active.noise.method,       params: { ...active.noise.params       } },
    compression: { method: active.compression.method, params: { ...active.compression.params } },
    viz:         { method: active.viz.method,         params: { ...active.viz.params         } },
    viz2d:       { method: active.viz2d.method,       params: { ...active.viz2d.params       } },
  };

  const body = document.createElement("div");
  body.className = "dimred-modal-body";

  for (const section of SECTIONS) {
    body.appendChild(renderSection(section, working, descriptor));
  }

  let modalHandle = null;
  modalHandle = openModal({
    title: descriptor.label,
    body,
    actions: [
      { label: "Cancel" },
      {
        label: "Apply",
        primary: true,
        onClick: () => {
          // Heavy work (PCA + UMAP + recluster cascade) blocks the main
          // thread. Show "Running…" on the button, yield once via
          // setTimeout so the repaint lands, then run synchronously.
          // Modal closes when we manually call modalHandle.close()
          // after the work resolves.
          startProgress(modalHandle);
          setTimeout(async () => {
            try { await descriptor.applyChange(working); }
            catch (e) { console.error("[dimred-modal] applyChange failed:", e); }
            modalHandle.close();
          }, 30);
          return false;
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

function renderSection(section, working, descriptor) {
  const wrap = document.createElement("section");
  wrap.className = "dimred-modal-section";
  wrap.dataset.section = section.key;

  const title = document.createElement("h4");
  title.className = "dimred-modal-section-title";
  title.textContent = section.title;
  wrap.appendChild(title);

  if (section.sub) {
    const sub = document.createElement("div");
    sub.className = "dimred-modal-section-sub";
    sub.textContent = section.sub;
    wrap.appendChild(sub);
  }

  const algos = descriptor.listAlgos(section.family);

  // Algorithm picker.
  const algoRow = document.createElement("div");
  algoRow.className = "dimred-modal-row";
  const algoLabel = document.createElement("label");
  algoLabel.textContent = "Algorithm";
  algoRow.appendChild(algoLabel);

  const algoSelect = document.createElement("select");
  algoSelect.className = "dimred-modal-select";
  for (const a of algos) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.label || a.id;
    if (a.id === working[section.key].method) opt.selected = true;
    algoSelect.appendChild(opt);
  }
  algoRow.appendChild(algoSelect);
  wrap.appendChild(algoRow);

  // Description + params host (re-rendered on algo switch).
  const desc = document.createElement("div");
  desc.className = "dimred-modal-desc";
  wrap.appendChild(desc);

  const paramsHost = document.createElement("div");
  paramsHost.className = "dimred-modal-params";
  wrap.appendChild(paramsHost);

  function renderForAlgo(algoId) {
    const algo = algos.find(a => a.id === algoId);
    if (!algo) return;

    // Reset params: keep current if same algo, else seed from defaults.
    // Prefer slot-specific defaults when the algorithm declares them —
    // PCA-100 in noise, UMAP-50/50/0 in compression, UMAP-3/15/0.1 in
    // viz are sensible starting points; defaultParams() returns a
    // generic toy-friendly value as fallback.
    if (algoId === working[section.key].method) {
      // unchanged — keep working[section.key].params as-is
    } else {
      working[section.key].method = algoId;
      const fresh = (typeof algo.defaultParamsForSlot === "function")
        ? algo.defaultParamsForSlot(section.family)
        : algo.defaultParams();
      working[section.key].params = { ...fresh };
    }

    desc.textContent = algo.description || "";

    paramsHost.innerHTML = "";
    if (!algo.modalSchema || algo.modalSchema.length === 0) {
      const none = document.createElement("div");
      none.className = "dimred-modal-noparams";
      none.textContent = "No tuneable parameters.";
      paramsHost.appendChild(none);
      return;
    }
    for (const field of algo.modalSchema) {
      paramsHost.appendChild(renderField(field, working[section.key].params));
    }
  }

  // Don't mutate working.method here — renderForAlgo() compares the
  // requested algoId against the current working.method to decide
  // whether to reset params from defaults. Pre-setting method here
  // makes the comparison always read "unchanged", which silently
  // keeps the wrong params after a swap.
  algoSelect.addEventListener("change", () => {
    renderForAlgo(algoSelect.value);
  });

  renderForAlgo(working[section.key].method);
  return wrap;
}

function renderField(field, params) {
  const row = document.createElement("div");
  row.className = "dimred-modal-row";

  const label = document.createElement("label");
  label.textContent = field.label || field.key;
  row.appendChild(label);

  let readout = null;
  const input = buildInput(field, params, () => {
    if (readout) readout.textContent = formatField(field, params[field.key]);
  });
  row.appendChild(input);

  if (field.kind === "range" || field.kind === "int") {
    readout = document.createElement("span");
    readout.className = "dimred-modal-readout";
    readout.textContent = formatField(field, params[field.key]);
    row.appendChild(readout);
  }

  if (field.hint) {
    const h = document.createElement("div");
    h.className = "dimred-modal-hint";
    h.textContent = field.hint;
    row.appendChild(h);
  }
  return row;
}

function buildInput(field, params, onChange) {
  const cur = params[field.key];
  if (field.kind === "select") {
    const sel = document.createElement("select");
    for (const opt of (field.options || [])) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      if (cur === opt.value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => {
      params[field.key] = sel.value;
      onChange();
    });
    return sel;
  }
  const input = document.createElement("input");
  input.type = "range";
  input.min   = String(field.min  ?? 0);
  input.max   = String(field.max  ?? 100);
  input.step  = String(field.step ?? 1);
  input.value = String(cur ?? field.min ?? 0);
  input.addEventListener("input", () => {
    const v = field.kind === "int" ? parseInt(input.value, 10) : parseFloat(input.value);
    params[field.key] = v;
    onChange();
  });
  return input;
}

function formatField(field, value) {
  if (field.format) {
    try { return field.format(value); }
    catch (_) { /* fall through */ }
  }
  if (field.kind === "int") return String(value);
  const n = +value;
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 10)  return n.toFixed(1);
  return n.toFixed(2);
}
