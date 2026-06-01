"""Tests for the cluster-labelling card (MLC §7).

A `labelling` card attaches under a clustering-like card and labels EVERY
level of its ladder by the chosen methods, storing the result in the card
branch (result.byLevel keyed by level uid). Labelling is static; the
projection layer replays result.byLevel into state.clusterLabels, which the
scoring panel prefers over an inline recompute. Text methods (c-TF-IDF /
TF-IDF) are gated until paper titles are materialised into ctx.getText.

Uses `clean_page` (no BFS ingest) — synthetic ladder + a small embedding /
node table set straight into state.
"""


# data → dimred → multiLevel(2 levels) with a 2D embedding + years so the
# `representative` and `year` methods are available (text methods are not).
_BUILD_TREE = '''
    const wf = await import("/app/src/ui/workflow.js");
    const st = await import("/app/src/ui/state.js");
    wf.clearWorkflow();
    function lvl(uid, labels) {
        const ids = [...new Set(labels)].filter(x => x >= 0);
        return { uid, scope: "global", clusterResult: {
            method: "hdbscan", params: {},
            nodeCluster: new Int32Array(labels),
            clusters: ids.map(id => ({
                id, members: labels.map((c, i) => c === id ? i : -1).filter(i => i >= 0),
                colour: "#888",
            })),
        }};
    }
    const levels = [lvl("L0", [0,0,0,1,1,1]), lvl("L1", [0,0,1,1,2,2])];
    const data = wf.createStep({ type: "data",   label: "data" });
    const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
    wf.updateStepStatus(dim, "running");
    st.update({
        embedding: { d: 2, data: new Float32Array([0,0, 0.1,0, 0.2,0, 5,0, 5.1,0, 5.2,0]) },
        genResult: { nodes: [0,1,2,3,4,5].map((id, i) => ({ id, year: 2018 + i })) },
        _basePos: null,
    });
    wf.setStepResult(dim, { _basePos: null, dimredResult: {} });
    const ml = wf.createStep({ type: "multiLevel", label: "multi-layer sweep",
        params: { minSamples: 5 }, parentId: dim });
    wf.updateStepStatus(ml, "running");
    wf.setStepResult(ml, { multiLevelSweep: { candidates: [], curve: [], uidPrefix: ml } });
    const pk = wf.createStep({ type: "multiLevelPicker", label: "pick layers",
        params: { pickedCounts: [1, 2] }, parentId: ml });
    wf.updateStepStatus(pk, "running");
    wf.setStepResult(pk, { clusterLevels: levels, clusterResult: levels[1].clusterResult });
    wf.selectStep(pk);
'''


def test_labelling_card_labels_all_levels_and_gates_text(clean_page):
    """applyChange forks a labelling card, labels every level, and reports
    text methods as unavailable when no titles are materialised."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const desc = ld.getLayerDescriptor("labelling");
            const active = desc.getActive();
            await desc.applyChange({ methods: ["representative", "year"] });
            const card = wf.listSteps({ type: "labelling" }).slice(-1)[0];
            const res = card.result;
            const avail = {};
            for (const m of active.methods) avail[m.id] = m.available;
            return {
                hasClustering: active.hasClustering,
                nLevels:       active.nLevels,
                defaultSelected: active.selected,
                availRepresentative: avail.representative,
                availYear:     avail.year,
                availCTfidf:   avail.cTfidf,
                status:        card.status,
                parentIsMl:    card.parentId === pk,
                levelsLabelled: res && Object.keys(res.byLevel).length,
                l0HasPerCluster: !!(res && res.byLevel.L0 && res.byLevel.L0.perCluster.length),
            };
        }'''
    )
    assert out["hasClustering"] is True
    assert out["nLevels"] == 2
    assert out["availRepresentative"] is True
    assert out["availYear"] is True
    assert out["availCTfidf"] is False     # gated: no ctx.getText
    assert out["status"] == "done"
    assert out["parentIsMl"] is True
    assert out["levelsLabelled"] == 2
    assert out["l0HasPerCluster"] is True


def test_labelling_in_next_steps(clean_page):
    """Clustering-like cards offer labelling in their "+" menu."""
    out = clean_page.evaluate(
        '''async () => {
            const ns = await import("/app/src/ui/next-steps-rules.js");
            return {
                clustering: ns.addStepRulesFor("clustering").map(r => r.modal),
                multiLevel: ns.addStepRulesFor("multiLevelPicker").map(r => r.modal),
                labelling:  ns.addStepRulesFor("labelling").map(r => r.modal),
            };
        }'''
    )
    assert "labelling" in out["clustering"]
    assert "labelling" in out["multiLevel"]
    # A labelling card's add-step follow-on is the scoring card.
    assert out["labelling"] == ["scoring"]


def test_labelling_projects_into_scoring_slot(clean_page):
    """Selecting the labelling card replays result.byLevel into
    state.clusterLabels (the slot the scoring panel prefers)."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _BUILD_TREE + '''
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const proj = await import("/app/src/ui/workflow-projection.js");
            const desc = ld.getLayerDescriptor("labelling");
            await desc.applyChange({ methods: ["representative", "year"] });
            const card = wf.listSteps({ type: "labelling" }).slice(-1)[0];
            wf.selectStep(ml);
            proj.projectStepIntoLegacyState(card.id);
            const s = st.getState();
            return {
                hasLabels:  !!s.clusterLabels,
                hasL0:      !!(s.clusterLabels && s.clusterLabels.L0),
                hasL1:      !!(s.clusterLabels && s.clusterLabels.L1),
            };
        }'''
    )
    assert out["hasLabels"] is True
    assert out["hasL0"] is True
    assert out["hasL1"] is True


def test_scoring_panel_prefers_stored_labels(clean_page):
    """The scoring panel renders the stored label from state.clusterLabels
    rather than an inline 'Cluster N' fallback."""
    out = clean_page.evaluate(
        '''async () => {
            const st = await import("/app/src/ui/state.js");
            function lvl(uid, labels) {
                const ids = [...new Set(labels)].filter(x => x >= 0);
                return { uid, clusterResult: { method: "hdbscan", params: {},
                    nodeCluster: new Int32Array(labels),
                    clusters: ids.map(id => ({ id, count: labels.filter(c => c === id).length,
                        members: labels.map((c, i) => c === id ? i : -1).filter(i => i >= 0), colour: "#888" })) }};
            }
            // Single level so the panel scores it directly (no parent filter).
            st.update({
                clusterLevels: [lvl("L0", [0,0,0,1,1,1])],
                clusterLabels: { L0: { methods: [], perCluster: [
                    { clusterId: 0, byMethod: {}, combined: "MY LABEL A" },
                    { clusterId: 1, byMethod: {}, combined: "MY LABEL B" },
                ]}},
                engineRevision: (st.getState().engineRevision || 0) + 1,
            });
            const host = document.createElement("div");
            document.body.appendChild(host);
            const panel = await import("/app/src/ui/panels/cluster-scoring.js");
            panel.mount(host, st.getState(), {});
            await new Promise(r => setTimeout(r, 30));
            const labels = [...host.querySelectorAll(".panel-score-label")].map(n => n.textContent);
            return { labels };
        }'''
    )
    assert "MY LABEL A" in out["labels"]
    assert "MY LABEL B" in out["labels"]
