"""Node displacement — pre→post fusion movement (the cross-branch payoff).

Aligns the pre layout onto the post layout (Procrustes) then takes per-node
Euclidean distance: papers whose citation context disagrees with their
semantic position move the most. Pure compute + the card/colour/panel wiring.
"""


def test_displacement_compute_ranks_the_mover(clean_page):
    """pre == post for all nodes except one MODERATELY shifted → after the
    global Procrustes alignment that node ranks first. (A realistic shift, not
    a wild outlier — an outlier 10×+ the cloud diameter would smear the rigid
    fit across all nodes, which is expected Procrustes behaviour.)"""
    out = clean_page.evaluate(r'''async () => {
        const m = await import("/app/src/eval/node-displacement.js");
        const n = 8;
        // post: a cube of side 2 (diameter ~3.5).
        const post = Float32Array.from([
            0,0,0, 2,0,0, 0,2,0, 2,2,0, 0,0,2, 2,0,2, 0,2,2, 2,2,2,
        ]);
        // pre = post but node 3 moved ~1.1 units (modest vs cloud size).
        const pre = post.slice();
        pre[9] = 2 + 0.8; pre[10] = 2 + 0.8;   // node 3 (x,y)
        const res = m.computeDisplacement(pre, post, n);
        const others = res.ranked.slice(1).map(r => r.dist);
        return {
            ok: !!res,
            topId: res.ranked[0].id,
            topDist: res.ranked[0].dist,
            maxOther: Math.max(...others),
            correlation: res.correlation,
            distLen: res.dist.length,
        };
    }''')
    assert out["ok"] is True
    assert out["topId"] == 3                       # the displaced node ranks first
    assert out["topDist"] > out["maxOther"] * 2    # clearly above the rest
    assert out["correlation"] > 0.9                # good rigid fit (one modest mover)
    assert out["distLen"] == 8


def test_displacement_null_on_bad_input(clean_page):
    """Missing / wrong-length layouts → null (the card surfaces a message)."""
    out = clean_page.evaluate(r'''async () => {
        const m = await import("/app/src/eval/node-displacement.js");
        return {
            noPre:  m.computeDisplacement(null, new Float32Array(9), 3),
            shortPost: m.computeDisplacement(new Float32Array(9), new Float32Array(6), 3),
            zero:   m.computeDisplacement(new Float32Array(0), new Float32Array(0), 0),
        };
    }''')
    assert out["noPre"] is None
    assert out["shortPost"] is None
    assert out["zero"] is None


def test_displacement_card_wires_both_branches(clean_page):
    """The node-displacement card references both fusion branches as refIds
    and computes a result from the dimred card's pre/post basePos."""
    out = clean_page.evaluate(r'''async () => {
        const wf = await import("/app/src/ui/workflow.js");
        const ld = await import("/app/src/ui/modals/layer-descriptors.js");
        wf.clearWorkflow();
        const n = 8;
        const post = Float32Array.from([0,0,0, 2,0,0, 0,2,0, 2,2,0, 0,0,2, 2,0,2, 0,2,2, 2,2,2]);
        const pre  = post.slice();
        pre[9] = 2 + 0.8; pre[10] = 2 + 0.8;   // node 3 moves modestly
        const data = wf.createStep({ type: "data", label: "data" });
        const dim  = wf.createStep({ type: "dimred", label: "dimred", parentId: data });
        wf.updateStepStatus(dim, "running");
        wf.setStepResult(dim, {
            dimredResult: { d:1, data:new Float32Array([1]) }, _basePos: post,
            dimredResultPreFusion: { d:1, data:new Float32Array([2]) }, _basePosPreFusion: pre,
            fusionActive: true,
        });
        const preB  = wf.createStep({ type: "fusionBranch", label: "Pre-fusion",  params: { endpoint: "pre"  }, parentId: dim });
        const postB = wf.createStep({ type: "fusionBranch", label: "Post-fusion", params: { endpoint: "post" }, parentId: dim });
        wf.updateStepStatus(preB, "running");  wf.setStepResult(preB,  { endpoint: "pre"  });
        wf.updateStepStatus(postB, "running"); wf.setStepResult(postB, { endpoint: "post" });
        wf.selectStep(postB);

        await ld.getLayerDescriptor("nodeDisplacement").applyChange();
        const card = wf.listSteps({ type: "nodeDisplacement" }).slice(-1)[0];
        const nd = card.result && card.result.nodeDisplacement;
        return {
            status: card.status,
            parentIsDimred: card.parentId === dim,
            refIds: card.refIds,
            refPre: card.refIds && card.refIds[0] === preB,
            refPost: card.refIds && card.refIds[1] === postB,
            topMover: nd && nd.topMovers[0].id,
            hasDist: !!(nd && nd.dist && nd.dist.length === n),
        };
    }''')
    assert out["status"] == "done"
    assert out["parentIsDimred"] is True
    assert out["refPre"] is True and out["refPost"] is True
    assert out["topMover"] == 3                    # the moved node
    assert out["hasDist"] is True


def test_displacement_colour_mode_and_next_steps(clean_page):
    """When state.nodeDisplacement is set, the viewer offers the displacement
    colour modes; the fusion branch offers the displacement step."""
    out = clean_page.evaluate(r'''async () => {
        const cm = await import("/app/src/ui/viewer-shared/colour-modes.js");
        const ns = await import("/app/src/ui/next-steps-rules.js");
        const state = {
            clusterLevels: [], genResult: { nodes: [{id:0},{id:1}] },
            nodeDisplacement: { dist: Float32Array.from([0.1, 0.9]), max: 0.9, logMax: Math.log1p(0.9) },
        };
        const opts = cm.getColourModeOptions(state).map(o => o.value);
        const c0 = cm.baseColourFor({ id: 0 }, state, "displacement");
        const c1 = cm.baseColourFor({ id: 1 }, state, "displacement");
        return {
            hasDisp: opts.includes("displacement"),
            hasDispLog: opts.includes("displacement:log"),
            coloursDiffer: c0 !== c1,
            branchOffers: ns.addStepRulesFor("fusionBranch").map(r => r.modal),
        };
    }''')
    assert out["hasDisp"] is True
    assert out["hasDispLog"] is True
    assert out["coloursDiffer"] is True            # low vs high displacement → different colour
    assert "nodeDisplacement" in out["branchOffers"]
    assert "fusionComparison" in out["branchOffers"]   # compare-branch topology
