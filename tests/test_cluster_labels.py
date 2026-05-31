"""MLC-4 — multi-method cluster labelling module.

Embedding-based methods (representative paper, year span) work on real data
today; the text methods (c-TF-IDF / TF-IDF) are implemented + tested via an
injected text accessor and gate cleanly with a reason when no titles are
materialised (the toy's real subsets carry paperId + embedding only).
"""

import pytest


def test_label_methods_synthetic(clean_page):
    """c-TF-IDF distinguishes clusters by their characteristic terms,
    representative picks the centroid-nearest paper, year reports the span,
    and `combined` prefers the text label."""
    out = clean_page.evaluate(r'''async () => {
        const { labelClusters } = await import("/app/src/labelling/cluster-labels.js");
        const d = 2;
        const data = Float32Array.from([1,0, 0.9,0.1,  0,1, 0.1,0.9]);
        const cr = { nodeCluster: Int32Array.from([0,0,1,1]), clusters: [{id:0},{id:1}] };
        const texts = {
            0: "graph neural networks for molecules",
            1: "graph neural networks chemistry",
            2: "transformer language models nlp",
            3: "transformer attention language",
        };
        const ctx = {
            embedding: { d, data },
            nodes: [
                {id:0,paperId:"P0",year:2019},{id:1,paperId:"P1",year:2020},
                {id:2,paperId:"P2",year:2021},{id:3,paperId:"P3",year:2022},
            ],
            getText: (id) => texts[id],
        };
        const res = labelClusters(cr, ctx);
        const c0 = res.perCluster[0], c1 = res.perCluster[1];
        return {
            methodsAvail: res.methods.map(m => `${m.id}:${m.available}`),
            c0Terms: c0.byMethod.cTfidf.terms,
            c1Terms: c1.byMethod.cTfidf.terms,
            c0Rep: c0.byMethod.representative.paperId,
            c1Rep: c1.byMethod.representative.paperId,
            c0Combined: c0.combined,
        };
    }''')
    assert out["methodsAvail"] == ["representative:true", "year:true", "cTfidf:true", "tfidf:true"]
    assert "graph" in out["c0Terms"] and "transformer" not in out["c0Terms"]
    assert "transformer" in out["c1Terms"]
    assert out["c0Rep"] == "P0"
    assert out["c1Rep"] == "P2"
    assert "graph" in out["c0Combined"]


def test_text_methods_gate_without_titles(clean_page):
    """With no getText accessor the text methods report unavailable with a
    reason, and combined falls back to the representative paper + year."""
    out = clean_page.evaluate(r'''async () => {
        const { labelClusters } = await import("/app/src/labelling/cluster-labels.js");
        const data = Float32Array.from([1,0, 0,1]);
        const cr = { nodeCluster: Int32Array.from([0,1]), clusters: [{id:0},{id:1}] };
        const ctx = { embedding: { d: 2, data }, nodes: [{id:0,paperId:"P0",year:2019},{id:1,paperId:"P1",year:2020}] };
        const res = labelClusters(cr, ctx);
        const byId = Object.fromEntries(res.methods.map(m => [m.id, m]));
        return {
            cTfidfAvail: byId.cTfidf.available,
            cTfidfReason: byId.cTfidf.reason,
            repAvail: byId.representative.available,
            combined0: res.perCluster[0].combined,
        };
    }''')
    assert out["cTfidfAvail"] is False
    assert "title" in out["cTfidfReason"].lower()
    assert out["repAvail"] is True
    assert "P0" in out["combined0"]


@pytest.mark.slow
def test_representative_labels_real(page):
    """On real BFS-5000 the representative method labels every cluster with
    a real paperId; the text methods gate (no titles materialised)."""
    out = page.evaluate(r'''async () => {
        const { labelClusters } = await import("/app/src/labelling/cluster-labels.js");
        const st = await import("/app/src/ui/state.js");
        const s = st.getState();
        const cr = s.clusterResult;
        const ctx = { embedding: s.embedding, nodes: s.genResult.nodes };
        const res = labelClusters(cr, ctx);
        const byId = Object.fromEntries(res.methods.map(m => [m.id, m]));
        const allHavePaper = res.perCluster.every(p =>
            p.byMethod.representative && typeof p.byMethod.representative.paperId === "string");
        return {
            repAvail: byId.representative.available,
            cTfidfAvail: byId.cTfidf.available,
            nClusters: res.perCluster.length,
            allHavePaper,
        };
    }''')
    assert out["repAvail"] is True
    assert out["cTfidfAvail"] is False        # no titles materialised
    assert out["nClusters"] >= 1
    assert out["allHavePaper"] is True
