"""Tests for UI #2 granular build-out: adding a data source creates only
a data card, and adding dim-reduction does NOT auto-run clustering. The
user grows the tree one layer at a time via the per-card + buttons.

Uses `clean_page` (boots empty now that there's no auto-run on boot).
"""


def test_add_data_creates_only_data_card(clean_page):
    """dataDescriptor.applyChange ingests the data ONLY (no dimred /
    clustering cascade) and migration emits just the data card."""
    out = clean_page.evaluate(
        '''async () => {
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const wf = await import("/app/src/ui/workflow.js");
            const st = await import("/app/src/ui/state.js");
            wf.clearWorkflow();
            const desc = ld.getLayerDescriptor("data");
            const active = desc.getActive();          // current (toy) mode + params
            await desc.applyChange(active.method, active.params);
            const steps = wf.listSteps();
            const s = st.getState();
            return {
                count:        steps.length,
                types:        steps.map(x => x.type),
                hasGenResult: !!s.genResult,
                hasDimred:    !!s.dimredResult,
                hasClusters:  !!s.clusterLevels,
            };
        }'''
    )
    assert out["count"] == 1
    assert out["types"] == ["data"]
    assert out["hasGenResult"] is True        # data ingested
    assert out["hasDimred"] is False          # no dim-reduction yet
    assert out["hasClusters"] is False        # no clustering yet


def test_add_dimred_does_not_cascade_to_clustering(clean_page):
    """Adding a dim-reduction card runs redimred({cascade:false}) — a
    dimred card appears but clustering does NOT auto-run (no clustering
    card, clusterLevels stays empty)."""
    out = clean_page.evaluate(
        '''async () => {
            const ld = await import("/app/src/ui/modals/layer-descriptors.js");
            const wf = await import("/app/src/ui/workflow.js");
            const st = await import("/app/src/ui/state.js");
            wf.clearWorkflow();
            // 1. data card
            const dd = ld.getLayerDescriptor("data");
            const da = dd.getActive();
            await dd.applyChange(da.method, da.params);
            // 2. dim-reduction card (parents under the data card)
            const dimDesc = ld.getLayerDescriptor("dimred");
            await dimDesc.applyChange(dimDesc.getActive());
            const steps = wf.listSteps();
            const s = st.getState();
            return {
                types:            steps.map(x => x.type).sort(),
                hasClusteringCard: steps.some(x => x.type === "clustering"),
                hasDimred:        !!s.dimredResult,
                hasClusterLevels: !!s.clusterLevels,
            };
        }'''
    )
    assert out["types"] == ["data", "dimred"]
    assert out["hasClusteringCard"] is False
    assert out["hasDimred"] is True            # dim-reduction ran
    assert out["hasClusterLevels"] is False    # clustering did NOT cascade
