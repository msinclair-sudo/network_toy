"""Stage 1 of the multi-layer-from-sweep rework (HDBSCAN-only, §9 revamp).

inferHdbscan() was split into:
  - buildHdbscanModel()  — dist → coreDist → MST → dendrogram (depends on
    minSamples + data; the expensive O(n²) part, computed ONCE);
  - extractHdbscanLevel() — condense → select → resolve at a given
    minClusterSize (cheap; re-run per layer).

A multi-layer ladder at a shared minSamples reuses one model across many
sizes. These tests assert (a) the split reproduces single-run output
exactly, and (b) one model yields distinct partitions across sizes.

Uses `clean_page` (pure-module import; no real-data session).
"""


_SETUP = '''
    const h = await import("/app/src/clustering-hdbscan.js");
    const rng = await import("/app/src/rng.js");
    // 3 well-separated gaussian blobs, n=150, 3-D.
    const n = 150, d = 3;
    const data = new Float32Array(n * d);
    const rand = rng.mulberry32(7);
    const centres = [[0,0,0],[10,0,0],[0,10,0]];
    const nodes = [];
    for (let i = 0; i < n; i++) {
        const c = centres[i % 3];
        for (let k = 0; k < d; k++) data[i*d+k] = c[k] + (rand() - 0.5) * 2;
        nodes.push({ id: i, basePos: [data[i*d], data[i*d+1], data[i*d+2]] });
    }
    const genResult = { nodes };
    const dimred = { method: "identity", params: {}, n, d, data };
'''


def test_build_extract_matches_single_run(clean_page):
    """buildHdbscanModel + extractHdbscanLevel == inferHdbscan at the same
    params (identical nodeCluster labels)."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _SETUP + '''
            const params = { minSamples: 5, minClusterSize: 10 };
            const A = h.inferHdbscan(genResult, params, dimred);
            const model = h.buildHdbscanModel(genResult, params, dimred);
            const B = h.extractHdbscanLevel(model, params);
            let identical = A.nodeCluster.length === B.nodeCluster.length;
            for (let i = 0; identical && i < A.nodeCluster.length; i++) {
                if (A.nodeCluster[i] !== B.nodeCluster[i]) identical = false;
            }
            return { aClusters: A.clusters.length, bClusters: B.clusters.length, identical };
        }'''
    )
    assert out["aClusters"] == out["bClusters"] == 3
    assert out["identical"] is True


def test_one_model_many_sizes(clean_page):
    """A single model extracts distinct partitions across minClusterSize
    (coarse sizes collapse the 3 blobs; fine sizes keep them)."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _SETUP + '''
            const model = h.buildHdbscanModel(genResult, { minSamples: 5 }, dimred);
            const sizes = [5, 15, 40, 120];
            const counts = sizes.map(mcs =>
                h.extractHdbscanLevel(model, { minSamples: 5, minClusterSize: mcs }).clusters.length);
            return { sizes, counts };
        }'''
    )
    # Fine sizes resolve the 3 blobs; a size larger than a blob collapses them.
    assert out["counts"][0] == 3
    assert out["counts"][-1] < 3            # mcs=120 > blob size → fewer/merged
    assert out["counts"] == sorted(out["counts"], reverse=True)  # monotone non-increasing
