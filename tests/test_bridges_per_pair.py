"""Unit tests for computeBridgesPerPair — the lean per-pair bridge counter
that populates the multiLevelPicker heatmap. For every (childIdx, parentIdx)
where childIdx > parentIdx (finer than coarser), it counts child clusters
whose members straddle ≥ 2 parent clusters.

Pure-module test (no data load), runs against `clean_page`.
"""

# Three candidates over 6 nodes, designed so each (child, parent) pair has a
# known bridge count:
#   c0:  [0,0,0,0,0,0]   one cluster
#   c1:  [0,0,0,1,1,1]   two clusters
#   c2:  [0,0,1,1,2,2]   three clusters; cluster 1 = nodes {2,3} straddles
#                        c1 parents {0,1}  →  1 bridge vs c1
#                        c0 has only one parent, so no bridges vs c0
#   c1 vs c0:  c1's two children both fit inside c0's single parent → 0
#   c2 vs c0:  all 3 c2 children fit inside c0's single parent      → 0
#   c2 vs c1:  c2-cluster 0 = {0,1} ⊂ c1-0; c2-cluster 1 = {2,3} straddles
#              c1-{0,1}; c2-cluster 2 = {4,5} ⊂ c1-1  →  1 bridge
_FIXTURE = '''
    const cand = (labels) => ({
        clusterResult: {
            nodeCluster: new Int32Array(labels),
            clusters: [...new Set(labels)].filter(x => x >= 0).map(id => ({
                id, members: labels.map((c, i) => c === id ? i : -1).filter(i => i >= 0),
            })),
        },
    });
    const candidates = [
        cand([0,0,0,0,0,0]),
        cand([0,0,0,1,1,1]),
        cand([0,0,1,1,2,2]),
    ];
'''


def test_bridges_per_pair_shape(clean_page):
    """Output is { n, counts: Int32Array(n*n) } with only the strict upper
    triangle filled (child > parent)."""
    out = clean_page.evaluate(
        '''async () => {
            ''' + _FIXTURE + '''
            const m = await import("/app/src/ui/bridge-analysis.js");
            const { n, counts } = m.computeBridgesPerPair(candidates);
            return {
                n,
                length: counts.length,
                // Lower triangle + diagonal must be 0.
                diag:  [counts[0*n+0], counts[1*n+1], counts[2*n+2]],
                lower: [counts[0*n+1], counts[0*n+2], counts[1*n+2]],
                // Strict upper triangle: the cells we care about.
                upper: { c1_vs_c0: counts[1*n+0],
                         c2_vs_c0: counts[2*n+0],
                         c2_vs_c1: counts[2*n+1] },
            };
        }'''
    )
    assert out["n"] == 3
    assert out["length"] == 9
    assert out["diag"]  == [0, 0, 0]
    assert out["lower"] == [0, 0, 0]
    assert out["upper"]["c1_vs_c0"] == 0   # both c1 children fit inside one c0 parent
    assert out["upper"]["c2_vs_c0"] == 0   # all c2 children fit inside one c0 parent
    assert out["upper"]["c2_vs_c1"] == 1   # c2-cluster 1 straddles c1-{0,1}


def test_bridges_per_pair_handles_fewer_than_two(clean_page):
    """0 or 1 candidates → empty counts, no crash."""
    out = clean_page.evaluate(
        '''async () => {
            const m = await import("/app/src/ui/bridge-analysis.js");
            const empty = m.computeBridgesPerPair([]);
            const one   = m.computeBridgesPerPair([
                { clusterResult: { nodeCluster: new Int32Array([0,0,1,1]) } }
            ]);
            return {
                empty: { n: empty.n, length: empty.counts.length },
                one:   { n: one.n,   length: one.counts.length, val: one.counts[0] },
            };
        }'''
    )
    assert out["empty"] == { "n": 0, "length": 0 }
    assert out["one"]   == { "n": 1, "length": 1, "val": 0 }


def test_bridges_per_pair_skips_noise_nodes(clean_page):
    """Nodes with nodeCluster < 0 (HDBSCAN noise) are ignored at both ends."""
    out = clean_page.evaluate(
        '''async () => {
            const cand = (labels) => ({
                clusterResult: { nodeCluster: new Int32Array(labels) },
            });
            // 6 nodes; node 2 is noise in c1 (parent), node 5 is noise in c2 (child)
            // c1: [0,0,-1,1,1,1]
            // c2: [0,0,1,1,2,-1]
            // c2-cluster 0 = {0,1} ⊂ c1-0
            // c2-cluster 1 = {2,3} but node 2 has no parent → only contributes node 3 (parent 1)
            // c2-cluster 2 = {4} → parent 1 → not a bridge
            // → 0 bridges
            const candidates = [ cand([0,0,-1,1,1,1]), cand([0,0,1,1,2,-1]) ];
            const m = await import("/app/src/ui/bridge-analysis.js");
            const { n, counts } = m.computeBridgesPerPair(candidates);
            return { n, c1_vs_c0: counts[1*n+0] };
        }'''
    )
    assert out["n"] == 2
    assert out["c1_vs_c0"] == 0


def test_bridges_per_pair_classic_straddle(clean_page):
    """Sanity check: every child cluster straddles two parents → bridge count
    equals child cluster count."""
    out = clean_page.evaluate(
        '''async () => {
            const cand = (labels) => ({
                clusterResult: { nodeCluster: new Int32Array(labels) },
            });
            // 8 nodes
            // parent: 4 evenly-sized parents [0,0,1,1,2,2,3,3]
            // child:  4 children that each straddle two parents
            //         child 0 = nodes {0,2} → parents {0,1}
            //         child 1 = nodes {1,3} → parents {0,1}
            //         child 2 = nodes {4,6} → parents {2,3}
            //         child 3 = nodes {5,7} → parents {2,3}
            const candidates = [
                cand([0,0,1,1,2,2,3,3]),
                cand([0,1,0,1,2,3,2,3]),
            ];
            const m = await import("/app/src/ui/bridge-analysis.js");
            const { n, counts } = m.computeBridgesPerPair(candidates);
            return { n, c1_vs_c0: counts[1*n+0] };
        }'''
    )
    assert out["c1_vs_c0"] == 4
