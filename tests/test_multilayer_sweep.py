"""Multi-layer sweep (eval/multilayer-sweep.js) — producer/picker split.

The sweep no longer auto-selects layers. Phase 1 maps minClusterSize→
clusterCount over one shared model; plateaus give candidate granularities;
Phase 2 (runPhase2Score) bootstraps EVERY candidate and returns the whole
scored set (each candidate retaining its clusterResult) plus a metadata
curve. The user then clicks granularities on the reproducibility curve and
buildLayersFromPicks() turns the picked cluster counts into the coarse→fine
clusterLevels[] ladder — no sweep re-run.

Uses `clean_page` (pure-module import). The e2e uses a small B + n so it
runs fast.
"""


def test_pure_helpers(clean_page):
    """logSpacedSizes / findPlateauCandidates / buildLayersFromPicks."""
    out = clean_page.evaluate(
        '''async () => {
            const ms = await import("/app/src/eval/multilayer-sweep.js");
            const sizes = ms.logSpacedSizes(1000, 25);
            const cands = ms.findPlateauCandidates([
                {size:2,count:8},{size:3,count:8},
                {size:5,count:5},{size:8,count:5},{size:12,count:5},
                {size:20,count:3},{size:40,count:3},
                {size:80,count:1},
            ]);
            // buildLayersFromPicks: pick a subset of candidate counts → a
            // coarse→fine ladder; unknown picks dropped; dups collapsed.
            const scored = [
                {count:3, size:40, stability:0.9, clusterResult:{nodeCluster:new Int32Array([0])}},
                {count:5, size:12, stability:0.7, clusterResult:{nodeCluster:new Int32Array([1])}},
                {count:8, size:3,  stability:0.8, clusterResult:{nodeCluster:new Int32Array([2])}},
            ];
            const ladder = ms.buildLayersFromPicks(scored, [8, 3, 99, 3], "PFX");
            return {
                sizesMonotone: sizes.every((v,i)=>i===0||v>sizes[i-1]),
                sizesLo: sizes[0], sizesHi: sizes[sizes.length-1],
                candCounts: cands.map(c=>c.count),
                ladderCounts: ladder.map(l=>l.numClusters),
                ladderUids:   ladder.map(l=>l.uid),
                ladderHasCR:  ladder.every(l=>l.clusterResult && l.clusterResult.nodeCluster),
            };
        }'''
    )
    assert out["sizesMonotone"] is True
    assert out["sizesLo"] == 2 and out["sizesHi"] == 500     # 2 .. n/2
    assert out["candCounts"] == [3, 5, 8]                    # count<2 dropped
    # picks {8,3,99,3} → dedup, drop unknown 99, sort coarse→fine → [3,8]
    assert out["ladderCounts"] == [3, 8]
    assert out["ladderUids"] == ["PFX-L0", "PFX-L1"]
    assert out["ladderHasCR"] is True                        # clusterResults retained


def test_sweep_scores_all_candidates(clean_page):
    """End-to-end: a 2-coarse / 4-fine blob hierarchy. runPhase2Score scores
    EVERY candidate (keeping its clusterResult); the curve exposes both the
    2- and 4-cluster granularities; buildLayersFromPicks turns a manual pick
    of {2,4} into a reproducible coarse→fine ladder. Exercises Phase 1
    extract, plateau candidates, and subsample-scaled Phase-2 bootstrap."""
    out = clean_page.evaluate(
        '''async () => {
            const ms  = await import("/app/src/eval/multilayer-sweep.js");
            const h   = await import("/app/src/clustering-hdbscan.js");
            const reg = await import("/app/src/clustering-registry.js");
            const rng = await import("/app/src/rng.js");
            const nPer = 40, d = 3;
            const groups = [[0,0,0],[2,0,0],[20,0,0],[22,0,0]];   // 2 super-blobs of 2 sub-blobs
            const n = nPer * groups.length;
            const data = new Float32Array(n * d); const nodes = [];
            const rand = rng.mulberry32(3); let idx = 0;
            for (const g of groups) for (let k = 0; k < nPer; k++) {
                for (let c = 0; c < d; c++) data[idx*d+c] = g[c] + (rand()-0.5)*0.8;
                nodes.push({ id: idx, basePos: [data[idx*d],data[idx*d+1],data[idx*d+2]] });
                idx++;
            }
            const genResult = { nodes };
            const dimred = { method:"identity", params:{}, n, d, data };
            // leaf, as the production multi-layer sweep uses.
            const params = { minSamples: 5, selectionMethod: "leaf", uidPrefix: "MLT" };
            const model = h.buildHdbscanModel(genResult, params, dimred);
            const out = await ms.runMultilayerSweep({
                model, genResult, dimredResult: dimred, algo: reg.getAlgorithm("hdbscan"),
                params, sizeGridCount: 18,
                bootstrapOpts: { B: 5, subsampleFrac: 0.7 },
            });
            // Manual pick: the 2- and 4-cluster granularities.
            const ladder = ms.buildLayersFromPicks(out.candidates, [2, 4], "MLT");
            return {
                curveCounts:   out.curve.map(c => c.count),
                candHaveCR:    out.candidates.every(c => c.clusterResult && c.clusterResult.nodeCluster),
                candScored:    out.candidates.every(c => c.stability === null || Number.isFinite(c.stability)),
                ladderCounts:  ladder.map(l => l.numClusters),
                ladderUids:    ladder.map(l => l.uid),
                coarseToFine:  ladder.every((l,i)=>i===0||l.numClusters>ladder[i-1].numClusters),
            };
        }'''
    )
    assert 2 in out["curveCounts"] and 4 in out["curveCounts"]
    assert out["candHaveCR"] is True            # every candidate keeps its clusterResult
    assert out["candScored"] is True
    assert out["ladderCounts"] == [2, 4]        # the manual pick → coarse→fine ladder
    assert out["ladderUids"] == ["MLT-L0", "MLT-L1"]
    assert out["coarseToFine"] is True
