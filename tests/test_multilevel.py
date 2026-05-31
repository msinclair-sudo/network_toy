"""MLC-1/2 — multi-level clustering: discover λ-shelves from one HDBSCAN
condensed tree, extract a coarse→fine partition ladder with bridge-
producing absorption, and fan the distance matrix out across cores.

Pure tree maths (discoverLayers/flattenFrontier) are tested via a synthetic
tree; the engine lane + nested-worker fan-out are exercised on real data.
"""

import pytest


# ── Pure tree maths (no clustering run needed) ──────────────────────────
def test_discover_and_flatten_synthetic(clean_page):
    """A hand-built balanced tree must yield 2→3→4-cluster layers and the
    frontier cuts must match by hand."""
    out = clean_page.evaluate(r'''async () => {
        const m = await import("/app/src/clustering-multilevel.js");
        const tree = {
            numNodes: 7, n: 8, root: 0,
            parent:      Int32Array.from([-1,0,0,1,1,2,2]),
            birthLambda: Float64Array.from([0,1,1,3,3,6,6]),
            stability:   Float64Array.from([0,2,2,1,1,1,1]),
            size:        Int32Array.from([8,4,4,2,2,2,2]),
            leafHome:    Int32Array.from([3,3,4,4,5,5,6,6]),
            leafLambda:  Float64Array.from([8,8,8,8,8,8,8,8]),
        };
        const layers = m.discoverLayers(tree);
        const cut = (lam) => {
            const f = m.flattenFrontier(tree, lam);
            return Array.from(m.relabelFrontier(f, 8).labels).join("");
        };
        return {
            counts: layers.map(l => l.clusterCount),
            ordered: layers.every((l, i) => i === 0 || l.clusterCount > layers[i-1].clusterCount),
            cut2: cut(layers[0].lambda),
            cut3: cut(layers[1].lambda),
            cut4: cut(layers[2].lambda),
        };
    }''')
    assert out["counts"] == [2, 3, 4]
    assert out["ordered"] is True
    assert out["cut2"] == "00001111"          # A | B
    assert out["cut3"] == "00112222"          # A1 | A2 | B
    assert out["cut4"] == "00112233"          # A1 | A2 | B1 | B2


def test_absorb_via_mst_crosses_branches(clean_page):
    """Stripped points are absorbed into the nearest cluster over the MST —
    and can attach to a different branch than their tree home (the bridge
    mechanism)."""
    out = clean_page.evaluate(r'''async () => {
        const m = await import("/app/src/clustering-multilevel.js");
        // path graph 0-1-2-3-4-5-6-7, unit weights
        const mst = [0,1,2,3,4,5,6].map(i => ({ i, j: i+1, w: 1 }));
        const adj = m.buildMstAdjacency(mst, 8);
        const labels = Int32Array.from([0,0,0,-1,-1,1,1,1]);
        m.absorbViaMST(labels, adj, 8);
        return { labels: Array.from(labels) };
    }''')
    # the two stripped middle points split to opposite clusters by MST distance
    assert -1 not in out["labels"]
    assert out["labels"] == [0, 0, 0, 0, 1, 1, 1, 1]


# ── Parallel distance fan-out correctness (main-thread spawn) ───────────
def test_parallel_distance_matches_sync(clean_page):
    """The cross-core distance matrix must equal the single-thread one. Use
    n=1500 (> PARALLEL_MIN_N) so the fan-out actually runs."""
    out = clean_page.evaluate(r'''async () => {
        const pd = await import("/app/src/workers/parallel-distance.js");
        const n = 1500, d = 8;
        // seeded LCG so the test is deterministic
        let s = 12345 >>> 0;
        const rnd = () => (s = (1103515245 * s + 12345) >>> 0) / 4294967296;
        const data = new Float32Array(n * d);
        for (let i = 0; i < data.length; i++) data[i] = rnd();
        const dimred = { method: "test", params: {}, n, d, data };
        const A = pd.pairwiseDistancesSync(dimred, n);
        const B = await pd.pairwiseDistancesParallel(dimred, n, { concurrency: 4 });
        let maxDiff = 0;
        for (let i = 0; i < A.length; i++) {
            const diff = Math.abs(A[i] - B[i]);
            if (diff > maxDiff) maxDiff = diff;
        }
        return { lenA: A.length, lenB: B.length, maxDiff };
    }''')
    assert out["lenA"] == 1500 * 1500
    assert out["lenB"] == out["lenA"]
    assert out["maxDiff"] < 1e-4


# ── Engine lane (toy, fast) ─────────────────────────────────────────────
def test_multilevel_engine_toy(toy_page):
    """recomputeMultiLevel lands a valid coarse→fine ladder in
    state.clusterLevels with bridge analysis, on toy data."""
    out = toy_page.evaluate(r'''async () => {
        const engine = await import("/app/src/ui/engine.js");
        const st = await import("/app/src/ui/state.js");
        const res = await engine.recomputeMultiLevel({ params: { minSamples: 5, minClusterSize: 5 } });
        const s = st.getState();
        const lv = s.clusterLevels || [];
        // partitions must be coarse→fine (non-decreasing cluster count) and
        // every point assigned (absorption leaves no noise).
        const counts = lv.map(l => l.clusterResult.clusters.length);
        let noNoise = true, contiguous = true;
        for (const l of lv) {
            const nc = l.clusterResult.nodeCluster;
            let max = -1; const seen = new Set();
            for (let i = 0; i < nc.length; i++) {
                if (nc[i] < 0) { noNoise = false; }
                if (nc[i] > max) max = nc[i];
                seen.add(nc[i]);
            }
            for (let c = 0; c <= max; c++) if (!seen.has(c)) contiguous = false;
        }
        return {
            nLevels: lv.length,
            counts,
            ascending: counts.every((c, i) => i === 0 || c >= counts[i-1]),
            noNoise,
            contiguous,
            hasBridge: !!s.bridgeAnalysis,
            nLayers: (s.multiLevelLayers || []).length,
            method: lv[0] && lv[0].clusterResult.method,
            hasTree: !!(lv[0] && lv[0].clusterResult.condensedTree),
        };
    }''')
    assert out["nLevels"] >= 2, f"expected ≥2 layers, got {out['nLevels']} ({out['counts']})"
    assert out["method"] == "hdbscan"
    assert out["ascending"] is True
    assert out["noNoise"] is True
    assert out["contiguous"] is True
    assert out["hasBridge"] is True
    assert out["hasTree"] is True


def test_multilevel_card_and_projection_toy(toy_page):
    """The multiLevel descriptor creates a card under the dimred ancestor,
    the job lands clusterLevels in the card result, and selecting the card
    projects them into legacy state."""
    out = toy_page.evaluate(r'''async () => {
        const ld = await import("/app/src/ui/modals/layer-descriptors.js");
        const wf = await import("/app/src/ui/workflow.js");
        const proj = await import("/app/src/ui/workflow-projection.js");
        const st = await import("/app/src/ui/state.js");

        // ensure a dimred card is in the selected lineage (toy_page yields
        // data→dimred→clustering; select the clustering leaf).
        const steps = wf.listSteps();
        const clust = steps.filter(s => s.type === "clustering").pop();
        wf.selectStep(clust.id);

        const desc = ld.getLayerDescriptor("multiLevel");
        const active = desc.getActive();
        await desc.applyChange({
            minSamples: active.defaults.minSamples,
            minClusterSize: active.defaults.minClusterSize,
            capLayers: active.defaults.capLayers,
        });

        const card = wf.listSteps().filter(s => s.type === "multiLevel").pop();
        // select the card and project it
        wf.selectStep(card.id);
        proj.projectStepIntoLegacyState(card.id);
        const s = st.getState();
        return {
            cardExists: !!card,
            status: card.status,
            cardLevels: card.result ? card.result.clusterLevels.length : 0,
            nLayers: card.result ? card.result.layers.length : 0,
            projectedLevels: (s.clusterLevels || []).length,
            parentType: wf.getStep(card.parentId).type,
        };
    }''')
    assert out["cardExists"] is True
    assert out["status"] == "done"
    assert out["cardLevels"] >= 2
    assert out["nLayers"] == out["cardLevels"]
    assert out["projectedLevels"] == out["cardLevels"]
    assert out["parentType"] == "dimred"


def test_bridge_panel_sections_and_tau(toy_page):
    """After a multi-level run, the bridge panel renders Encapsulated +
    Bridges sections that together account for every fine cluster, and the
    τ slider re-buckets without an engine recompute."""
    out = toy_page.evaluate(r'''async () => {
        const engine = await import("/app/src/ui/engine.js");
        const state = await import("/app/src/ui/state.js");
        await engine.recomputeMultiLevel({ params: { minSamples: 5, minClusterSize: 5 } });

        const host = document.createElement("div");
        document.body.appendChild(host);
        const { mount } = await import("/app/src/ui/panels/bridge-analysis.js");
        const inst = mount(host, state.getState(), {});
        await new Promise(r => setTimeout(r, 50));

        const heads = [...host.querySelectorAll(".panel-bridge-section-head")].map(e => e.textContent);
        const slider = host.querySelector(".panel-bridge-tau-slider");
        const totalFine = state.getState().bridgeAnalysis.perCluster.length;
        // count rows across both section tables
        const rowsAt = () => host.querySelectorAll(".panel-bridge-row").length;
        const rowsDefault = rowsAt();
        // lower τ to 0.5 → fewer/equal bridges; raise to 1.0 → more bridges
        slider.value = "1"; slider.dispatchEvent(new Event("input"));
        await new Promise(r => setTimeout(r, 20));
        const headsHigh = [...host.querySelectorAll(".panel-bridge-section-head")].map(e => e.textContent);

        inst.destroy();
        return {
            nHeads: heads.length,
            hasSlider: !!slider,
            totalFine,
            rowsDefault,
            // every fine cluster appears in exactly one section
            accounts: rowsDefault === totalFine,
            headsHighOk: headsHigh.length === 2,
        };
    }''')
    assert out["nHeads"] == 2                 # Encapsulated + Bridges
    assert out["hasSlider"] is True
    assert out["totalFine"] >= 2
    assert out["accounts"] is True
    assert out["headsHighOk"] is True


@pytest.mark.slow
def test_multilevel_engine_real(page):
    """Real BFS-5000: the nested-worker distance fan-out runs inside the
    clustering worker, and a multi-level ladder lands with bridges."""
    out = page.evaluate(r'''async () => {
        const engine = await import("/app/src/ui/engine.js");
        const st = await import("/app/src/ui/state.js");
        const res = await engine.recomputeMultiLevel({ params: { minSamples: 5, minClusterSize: 15 } });
        const s = st.getState();
        const lv = s.clusterLevels || [];
        const counts = lv.map(l => l.clusterResult.clusters.length);
        let noNoise = true;
        for (const l of lv) for (let i = 0; i < l.clusterResult.nodeCluster.length; i++)
            if (l.clusterResult.nodeCluster[i] < 0) noNoise = false;
        // bridges should actually appear at real scale (absorbed cuts)
        const bridgeCount = s.bridgeAnalysis ? s.bridgeAnalysis.bridgeCount : 0;
        return {
            n: s.genResult.nodes.length,
            nLevels: lv.length,
            counts,
            noNoise,
            bridgeCount,
        };
    }''')
    assert out["n"] == 5000
    assert out["nLevels"] >= 2
    assert out["noNoise"] is True
    assert out["counts"] == sorted(out["counts"])
