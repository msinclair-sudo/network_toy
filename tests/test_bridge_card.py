"""Tests for the bridge-analysis card — the first "analysis layer".

Bridges are a PER-LAYER relationship (§9): for every committed layer i ≥ 1,
each cluster in layer i is checked against the clusters in the layer above it
(i − 1). The bridge card runs this across ALL layers in one pass (no
fine/coarse pair to pick), attaches under the layer picker, and sits in the
pipeline picker → bridge → labelling → scoring.

Uses `clean_page` (no BFS ingest) — the whole flow is pure-module logic over
a synthetic level ladder built by hand.
"""


# data → dimred → multiLevel(sweep) → picker(3 levels). The ladder is designed
# so exactly one L2 cluster straddles two L1 parents → one bridge total:
#   L0: [0,0,0,0,0,0]   one coarse cluster   (L1 vs L0 → 0 bridges)
#   L1: [0,0,0,1,1,1]   two parents
#   L2: [0,0,1,1,2,2]   cluster 1 = nodes 2,3 → spans L1{0,1}  (L2 vs L1 → 1 bridge)
_BUILD_TREE = '''
    const wf = await import("/app/src/ui/workflow.js");
    wf.clearWorkflow();
    function lvl(uid, labels) {
        const ids = [...new Set(labels)].filter(x => x >= 0);
        return { uid, scope: "global", clusterResult: {
            method: "hdbscan", params: {},
            nodeCluster: new Int32Array(labels),
            clusters: ids.map(id => ({
                id,
                members: labels.map((c, i) => c === id ? i : -1).filter(i => i >= 0),
                colour: "#888",
            })),
        }};
    }
    const levels = [
        lvl("L0", [0,0,0,0,0,0]),
        lvl("L1", [0,0,0,1,1,1]),
        lvl("L2", [0,0,1,1,2,2]),
    ];
    const data = wf.createStep({ type: "data",   label: "data" });
    const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
    wf.updateStepStatus(dim, "running");
    wf.setStepResult(dim, { _basePos: new Float32Array(18), dimredResult: {} });
    const ml = wf.createStep({ type: "multiLevel", label: "multi-layer sweep",
        params: { minSamples: 5 }, parentId: dim });
    wf.updateStepStatus(ml, "running");
    wf.setStepResult(ml, { multiLevelSweep: { candidates: [], curve: [], uidPrefix: ml } });
    const pk = wf.createStep({ type: "multiLevelPicker", label: "pick layers",
        params: { pickedCounts: [1, 2, 3] }, parentId: ml });
    wf.updateStepStatus(pk, "running");
    wf.setStepResult(pk, { clusterLevels: levels, clusterResult: levels[2].clusterResult });
    wf.selectStep(pk);
'''


def test_bridge_card_runs_all_layers(clean_page):
    """applyChange (no params) forks a bridge card under the picker and
    computes per-layer bridges across the whole ladder: byLayer has one entry
    per layer i≥1, totalBridges counts the straddles (here: 1, the L2 cluster
    spanning two L1 parents)."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const desc = ld.getLayerDescriptor("bridgeAnalysis");
            const active = desc.getActive();
            await desc.applyChange();
            const card = wf.listSteps({ type: "bridgeAnalysis" }).slice(-1)[0];
            const all = card.result && card.result.bridgeAllLayers;
            const finest = card.result && card.result.bridgeAnalysis;
            return {
                hasClustering: active.hasClustering,
                nLevels:       active.nLevels,
                status:        card.status,
                parentIsPicker: card.parentId === pk,
                byLayerLayers: all && all.byLayer.map(b => b.layer),
                perLayerBridges: all && all.byLayer.map(b => b.bridgeCount),
                totalBridges:  all && all.totalBridges,
                finestBridges: finest && finest.bridgeCount,
            };
        }'''
    )
    assert out["hasClustering"] is True
    assert out["nLevels"] == 3
    assert out["status"] == "done"
    assert out["parentIsPicker"] is True
    assert out["byLayerLayers"] == [1, 2]          # layers 1 and 2 (0 has no parent)
    assert out["perLayerBridges"] == [0, 1]        # L1 vs L0: 0 ; L2 vs L1: 1
    assert out["totalBridges"] == 1
    assert out["finestBridges"] == 1               # viewer pair view (L2 vs L1)


def test_bridge_in_pipeline_next_steps(clean_page):
    """The picker offers bridge analysis; a bridge card offers labelling
    (the chain flows picker → bridge → labelling → scoring)."""
    out = clean_page.evaluate(
        '''async () => {
            const ns = await import("/app/src/ui/next-steps-rules.js");
            return {
                clustering: ns.addStepRulesFor("clustering").map(r => r.modal),
                picker:     ns.addStepRulesFor("multiLevelPicker").map(r => r.modal),
                bridge:     ns.addStepRulesFor("bridgeAnalysis").map(r => r.modal),
            };
        }'''
    )
    assert "bridgeAnalysis" in out["clustering"]
    assert "bridgeAnalysis" in out["picker"]        # picker → bridge
    assert "labelling" in out["bridge"]             # bridge → labelling


def test_bridge_card_projects_into_panel_slots(clean_page):
    """Selecting a bridge card replays its result into state.bridgeAnalysis
    (finest pair, for the viewer/legacy panel) + state.bridgeAllLayers (the
    per-layer breakdown), and the picker's levels are projected too."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const proj = await import("/app/src/ui/workflow-projection.js");
            const st = await import("/app/src/ui/state.js");
            const desc = ld.getLayerDescriptor("bridgeAnalysis");
            await desc.applyChange();
            const card = wf.listSteps({ type: "bridgeAnalysis" }).slice(-1)[0];
            wf.selectStep(ml);
            proj.projectStepIntoLegacyState(card.id);
            const s = st.getState();
            return {
                hasBA:       !!s.bridgeAnalysis,
                baBridges:   s.bridgeAnalysis && s.bridgeAnalysis.bridgeCount,
                hasAllLayers: !!s.bridgeAllLayers,
                allTotal:    s.bridgeAllLayers && s.bridgeAllLayers.totalBridges,
                hasLevels:   Array.isArray(s.clusterLevels) && s.clusterLevels.length,
            };
        }'''
    )
    assert out["hasBA"] is True
    assert out["baBridges"] == 1
    assert out["hasAllLayers"] is True
    assert out["allTotal"] == 1
    assert out["hasLevels"] == 3            # picker's ladder projected (panel needs it)


def test_bridge_card_rerun_overwrites_in_place(clean_page):
    """Re-running a bridge card via the gear (editStepId) overwrites the same
    card instead of forking a new one (no params to change — it always runs
    all layers)."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const desc = ld.getLayerDescriptor("bridgeAnalysis");
            await desc.applyChange();
            const card = wf.listSteps({ type: "bridgeAnalysis" }).slice(-1)[0];
            const countBefore = wf.listSteps({ type: "bridgeAnalysis" }).length;
            const editDesc = ld.getLayerDescriptor("bridgeAnalysis", card.id);
            await editDesc.applyChange();
            const countAfter = wf.listSteps({ type: "bridgeAnalysis" }).length;
            const same = wf.getStep(card.id);
            return {
                countBefore, countAfter,
                sameStatus: same && same.status,
                sameTotal: same && same.result && same.result.bridgeAllLayers
                    && same.result.bridgeAllLayers.totalBridges,
            };
        }'''
    )
    assert out["countBefore"] == out["countAfter"] == 1   # no new card
    assert out["sameStatus"] == "done"
    assert out["sameTotal"] == 1
