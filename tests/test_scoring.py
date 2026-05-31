"""MLC-5 — tree scoring panel: 1–5 per cluster, layer-by-layer with
parent-score threshold propagation, scores persisted on state.clusterScores
(keyed by level uid) through the save/load round-trip."""

import pytest


def _run_multilevel(page):
    page.evaluate(r'''async () => {
        const engine = await import("/app/src/ui/engine.js");
        await engine.recomputeMultiLevel({ params: { minSamples: 5, minClusterSize: 5 } });
    }''')


def test_scoring_panel_click_sets_score(toy_page):
    """Clicking a star writes state.clusterScores[levelUid][clusterId] and
    the star renders active + the summary updates."""
    _run_multilevel(toy_page)
    out = toy_page.evaluate(r'''async () => {
        const st = await import("/app/src/ui/state.js");
        const host = document.createElement("div");
        document.body.appendChild(host);
        const { mount } = await import("/app/src/ui/panels/cluster-scoring.js");
        const inst = mount(host, st.getState(), {});
        await new Promise(r => setTimeout(r, 30));

        const levels = st.getState().clusterLevels;
        const l0uid = levels[0].uid;

        // click the "4" star on the first cluster row
        const firstRow = host.querySelector(".panel-score-row");
        const stars = firstRow.querySelectorAll(".panel-score-star");
        stars[3].click();   // value 4
        await new Promise(r => setTimeout(r, 30));

        const scores = st.getState().clusterScores[l0uid] || {};
        const activeNow = host.querySelector(".panel-score-row .panel-score-star.active");
        const summary = host.querySelector(".panel-score-summary").textContent;

        inst.destroy();
        return {
            score0: scores[0],
            activeText: activeNow ? activeNow.textContent : null,
            summary,
        };
    }''')
    assert out["score0"] == 4
    assert out["activeText"] == "4"
    assert out["summary"].startswith("1 /")


def test_scoring_parent_threshold_filters(toy_page):
    """At a finer layer, raising the parent-score threshold hides children
    whose dominant parent is unscored / low-scored."""
    _run_multilevel(toy_page)
    out = toy_page.evaluate(r'''async () => {
        const st = await import("/app/src/ui/state.js");
        const levels = st.getState().clusterLevels;
        if (levels.length < 2) return { skip: true };

        const host = document.createElement("div");
        document.body.appendChild(host);
        const { mount } = await import("/app/src/ui/panels/cluster-scoring.js");
        const inst = mount(host, st.getState(), {});
        await new Promise(r => setTimeout(r, 30));

        // switch to layer 1
        const sel = host.querySelector(".panel-score-select");
        sel.value = "1"; sel.dispatchEvent(new Event("change"));
        await new Promise(r => setTimeout(r, 30));

        const rowsThresholdAny = host.querySelectorAll(".panel-score-row").length;

        // raise parent threshold to 5 (no parents scored ⇒ all hidden)
        const range = host.querySelector(".panel-score-range");
        range.value = "5"; range.dispatchEvent(new Event("input"));
        await new Promise(r => setTimeout(r, 30));
        const rowsThreshold5 = host.querySelectorAll(".panel-score-row").length;

        inst.destroy();
        return { rowsThresholdAny, rowsThreshold5, nL1: levels[1].clusterResult.clusters.length };
    }''')
    if out.get("skip"):
        pytest.skip("toy multi-level produced <2 layers")
    assert out["rowsThresholdAny"] == out["nL1"]    # τ=0.8, threshold=any → all shown
    assert out["rowsThreshold5"] == 0               # no parent scored ≥5 → all hidden


def test_scores_persist_round_trip(toy_page):
    """clusterScores survive serialise → deserialise."""
    _run_multilevel(toy_page)
    out = toy_page.evaluate(r'''async () => {
        const st  = await import("/app/src/ui/state.js");
        const ser = await import("/app/src/persistence/serialise.js");
        const des = await import("/app/src/persistence/deserialise.js");

        const uid = st.getState().clusterLevels[0].uid;
        st.setClusterScore(uid, 0, 5);
        st.setClusterScore(uid, 1, 3);

        const blob = ser.serialiseState(st.getState());
        const file = new File([blob], "scores.zip", { type: "application/zip" });
        const { patch } = await des.deserialiseFile(file);

        const restored = patch.clusterScores && patch.clusterScores[uid];
        return { uid, s0: restored && restored[0], s1: restored && restored[1] };
    }''')
    assert out["s0"] == 5
    assert out["s1"] == 3
