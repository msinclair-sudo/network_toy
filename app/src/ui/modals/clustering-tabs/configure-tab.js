// Configure tab — the existing multi-level clustering editor.
//
// Renders into a host element passed in by the parent modal. Returns
// a {render, getWorking} interface. The parent calls getWorking() at
// Apply time to commit changes.

export function buildConfigureTab(host, descriptor) {
  const active = descriptor.getActive();
  const algos  = descriptor.listAlgos();

  let chosenAlgoId = active.method;
  let chosenLevels = active.levels.map(l => ({
    uid:    l.uid,
    params: { ...l.params },
    scope:  l.scope,
  }));

  // ── algorithm dropdown ───────────────────────────────────────────
  const algoRow = document.createElement("div");
  algoRow.className = "algorithm-modal-algo-row";
  const algoLabel = document.createElement("label");
  algoLabel.textContent = "Algorithm";
  algoRow.appendChild(algoLabel);
  const algoSelect = document.createElement("select");
  for (const a of algos) {
    const opt = document.createElement("option");
    opt.value = a.id;
    opt.textContent = a.label || a.id;
    if (a.id === chosenAlgoId) opt.selected = true;
    algoSelect.appendChild(opt);
  }
  algoRow.appendChild(algoSelect);
  host.appendChild(algoRow);

  const algoDesc = document.createElement("div");
  algoDesc.className = "algorithm-modal-desc";
  host.appendChild(algoDesc);

  const levelsHost = document.createElement("div");
  levelsHost.className = "clustering-modal-levels";
  host.appendChild(levelsHost);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "clustering-modal-add";
  addBtn.textContent = "+ Add level";
  host.appendChild(addBtn);

  function findAlgo(id) {
    return algos.find(a => a.id === id);
  }

  function renderAll() {
    const algo = findAlgo(chosenAlgoId);
    algoDesc.textContent = algo.description || "";
    algoSelect.value = chosenAlgoId;
    levelsHost.innerHTML = "";
    chosenLevels.forEach((lvl, idx) => {
      levelsHost.appendChild(renderLevel(idx, lvl, algo));
    });
  }

  function renderLevel(idx, lvl, algo) {
    const root = document.createElement("div");
    root.className = "clustering-modal-level";

    const head = document.createElement("div");
    head.className = "clustering-modal-level-head";
    const title = document.createElement("div");
    title.className = "clustering-modal-level-title";
    title.textContent = idx === 0
      ? `Level ${idx}  (root, coarsest)`
      : `Level ${idx}`;
    head.appendChild(title);

    if (idx > 0) {
      const scopeWrap = document.createElement("div");
      scopeWrap.className = "clustering-modal-scope";
      scopeWrap.appendChild(scopeRadio(idx, "global",        "global",        lvl, "Re-cluster the whole dataset at this level."));
      scopeWrap.appendChild(scopeRadio(idx, "within-parent", "within parent", lvl, "Cluster within each previous-level cluster's members only."));
      head.appendChild(scopeWrap);

      const close = document.createElement("button");
      close.type = "button";
      close.className = "clustering-modal-level-close";
      close.title = "Remove this level";
      close.textContent = "×";
      close.addEventListener("click", () => {
        chosenLevels.splice(idx, 1);
        renderAll();
      });
      head.appendChild(close);
    }
    root.appendChild(head);

    const paramsHost = document.createElement("div");
    paramsHost.className = "clustering-modal-level-params";
    if (algo.modalSchema && algo.modalSchema.length > 0) {
      for (const field of algo.modalSchema) {
        paramsHost.appendChild(renderField(field, lvl.params));
      }
    } else {
      const none = document.createElement("div");
      none.className = "algorithm-modal-noparams";
      none.textContent = "No tuneable parameters.";
      paramsHost.appendChild(none);
    }
    root.appendChild(paramsHost);

    return root;
  }

  function scopeRadio(levelIdx, value, label, lvl, hint) {
    const lab = document.createElement("label");
    lab.className = "clustering-modal-scope-radio";
    lab.title = hint;
    const input = document.createElement("input");
    input.type = "radio";
    input.name = `scope-${levelIdx}`;
    input.value = value;
    if (lvl.scope === value) input.checked = true;
    input.addEventListener("change", () => {
      if (input.checked) lvl.scope = value;
    });
    lab.appendChild(input);
    const span = document.createElement("span");
    span.textContent = label;
    lab.appendChild(span);
    return lab;
  }

  function renderField(field, params) {
    const row = document.createElement("div");
    row.className = "algorithm-modal-row";

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
      readout.className = "algorithm-modal-readout";
      readout.textContent = formatField(field, params[field.key]);
      row.appendChild(readout);
    }

    if (field.hint) {
      const h = document.createElement("div");
      h.className = "algorithm-modal-hint";
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
    input.min  = String(field.min  ?? 0);
    input.max  = String(field.max  ?? 100);
    input.step = String(field.step ?? 1);
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
      catch (_) {}
    }
    if (field.kind === "int") return String(value);
    const n = +value;
    if (!Number.isFinite(n)) return "—";
    if (Math.abs(n) >= 100) return n.toFixed(0);
    if (Math.abs(n) >= 10)  return n.toFixed(1);
    return n.toFixed(2);
  }

  algoSelect.addEventListener("change", () => {
    chosenAlgoId = algoSelect.value;
    const algo = findAlgo(chosenAlgoId);
    chosenLevels = chosenLevels.map(l => ({
      uid:    l.uid,
      params: { ...algo.defaultParams() },
      scope:  l.scope,
    }));
    renderAll();
  });

  addBtn.addEventListener("click", () => {
    const algo = findAlgo(chosenAlgoId);
    chosenLevels.push({
      uid:    Math.random().toString(36).slice(2, 10),
      params: { ...algo.defaultParams() },
      scope:  "within-parent",
    });
    renderAll();
  });

  renderAll();

  return {
    getWorking: () => ({ algoId: chosenAlgoId, levels: chosenLevels }),
    // Allow the Optimise tab to "Apply this row" and overwrite our
    // working state when it does.
    overwrite: (algoId, levels) => {
      chosenAlgoId = algoId;
      chosenLevels = levels.map(l => ({ uid: l.uid, params: { ...l.params }, scope: l.scope }));
      renderAll();
    },
  };
}
