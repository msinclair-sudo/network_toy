"""Tests for the bridge-analysis card — the first "analysis layer".

A `bridgeAnalysis` card attaches under a clustering-like card (clustering
OR multi-layer), histograms a fine cluster level against a coarser parent
level, and records which fine clusters straddle ≥2 coarse parents
(bridges). It reuses the existing singleton bridge-analysis panel via the
projection layer (result.bridgeAnalysis → state.bridgeAnalysis).

Uses `clean_page` (no BFS ingest) — the whole flow is pure-module logic
over a synthetic level ladder built by hand.
"""


# data → dimred → multiLevel(3 levels). The ladder is designed so exactly
# one fine (L2) cluster straddles two L1 parents → bridgeCount == 1:
#   L0: [0,0,0,0,0,0]            one coarse cluster
#   L1: [0,0,0,1,1,1]            two parents
#   L2: [0,0,1,1,2,2]            cluster 1 = nodes 2,3 → parents L1{0,1}
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
    // Producer sweep + picker child (the picker holds the committed ladder
    // and is the clustering-equivalent bridge analysis attaches under).
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


def test_bridge_card_runs_and_counts_bridges(clean_page):
    """getLayerDescriptor('bridgeAnalysis').applyChange forks a bridge
    card under the selected multi-layer card, runs the derivation, and
    records the straddle count."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const desc = ld.getLayerDescriptor("bridgeAnalysis");
            const active = desc.getActive();
            await desc.applyChange({ fineLevel: 2, coarseLevel: 1 });
            const cards = wf.listSteps({ type: "bridgeAnalysis" });
            const card = cards[cards.length - 1];
            const ba = card.result && card.result.bridgeAnalysis;
            return {
                hasClustering: active.hasClustering,
                nLevels:       active.nLevels,
                status:        card.status,
                parentIsMl:    card.parentId === pk,
                fineLevel:     ba && ba.fineLevel,
                coarseLevel:   ba && ba.coarseLevel,
                bridgeCount:   ba && ba.bridgeCount,
            };
        }'''
    )
    assert out["hasClustering"] is True
    assert out["nLevels"] == 3
    assert out["status"] == "done"
    assert out["parentIsMl"] is True
    assert out["fineLevel"] == 2
    assert out["coarseLevel"] == 1
    assert out["bridgeCount"] == 1


def test_bridge_card_appears_in_next_steps(clean_page):
    """Clustering-like cards expose bridge analysis in their "+" menu."""
    out = clean_page.evaluate(
        '''async () => {
            const ns = await import("/app/src/ui/next-steps-rules.js");
            return {
                clustering: ns.addStepRulesFor("clustering").map(r => r.modal),
                multiLevel: ns.addStepRulesFor("multiLevelPicker").map(r => r.modal),
                bridge:     ns.addStepRulesFor("bridgeAnalysis").map(r => r.modal),
            };
        }'''
    )
    assert "bridgeAnalysis" in out["clustering"]
    assert "bridgeAnalysis" in out["multiLevel"]
    # A bridge card's only follow-on is re-run (no modal add-steps).
    assert out["bridge"] == []


def test_bridge_card_projects_into_panel_slots(clean_page):
    """Selecting a bridge card replays its result into state.bridgeAnalysis
    + bridgeConfig (the slots the singleton bridge panel reads)."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const proj = await import("/app/src/ui/workflow-projection.js");
            const st = await import("/app/src/ui/state.js");
            const desc = ld.getLayerDescriptor("bridgeAnalysis");
            await desc.applyChange({ fineLevel: 2, coarseLevel: 1 });
            const card = wf.listSteps({ type: "bridgeAnalysis" }).slice(-1)[0];
            // Move selection away, then re-select the bridge card.
            wf.selectStep(ml);
            proj.projectStepIntoLegacyState(card.id);
            const s = st.getState();
            return {
                hasBA:       !!s.bridgeAnalysis,
                baBridges:   s.bridgeAnalysis && s.bridgeAnalysis.bridgeCount,
                cfgFine:     s.bridgeConfig && s.bridgeConfig.fineLevel,
                cfgCoarse:   s.bridgeConfig && s.bridgeConfig.coarseLevel,
                hasLevels:   Array.isArray(s.clusterLevels) && s.clusterLevels.length,
            };
        }'''
    )
    assert out["hasBA"] is True
    assert out["baBridges"] == 1
    assert out["cfgFine"] == 2
    assert out["cfgCoarse"] == 1
    # The multi-layer ancestor's levels are also projected (panel needs them).
    assert out["hasLevels"] == 3


def test_bridge_card_edit_in_place(clean_page):
    """Editing a bridge card via the gear (editStepId) overwrites the same
    card with a new level pair instead of forking a new one."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const desc = ld.getLayerDescriptor("bridgeAnalysis");
            await desc.applyChange({ fineLevel: 2, coarseLevel: 1 });
            const card = wf.listSteps({ type: "bridgeAnalysis" }).slice(-1)[0];
            const countBefore = wf.listSteps({ type: "bridgeAnalysis" }).length;
            // Gear edit: same card id, new pair.
            const editDesc = ld.getLayerDescriptor("bridgeAnalysis", card.id);
            const prefill = editDesc.getActive();
            await editDesc.applyChange({ fineLevel: 1, coarseLevel: 0 });
            const countAfter = wf.listSteps({ type: "bridgeAnalysis" }).length;
            const same = wf.getStep(card.id);
            return {
                prefillFine:  prefill.fineLevel,
                countBefore, countAfter,
                editedFine:   same && same.params.fineLevel,
                editedCoarse: same && same.params.coarseLevel,
            };
        }'''
    )
    assert out["prefillFine"] == 2          # prefilled from the card's own params
    assert out["countBefore"] == out["countAfter"] == 1   # no new card
    assert out["editedFine"] == 1           # overwritten in place
    assert out["editedCoarse"] == 0
