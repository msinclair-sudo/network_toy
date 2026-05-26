"""Tests for the panel surfaces (§6.19 work):
  - validation-run-optimise (covered in test_optimise.py)
  - bootstrap-stability
  - method-receipt
  - bridge-analysis
  - fusion-comparison (+ NMI + comparePartitions helpers)
  - dim-sweep (+ heatmap + bars chart helpers + sweep runner)

Real-data (BFS-5000) page by default. Toy-only paths use toy_page.
"""

import pytest


# ── method-receipt ─────────────────────────────────────────────────────


def test_method_receipt_renders(page):
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/method-receipt.js");
            const state = await import("/app/src/ui/state.js");
            mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 100));
            return {
                bodyText: host.textContent,
                hasCopyBtn: !!host.querySelector("button"),
            };
        }'''
    )
    # Sanity: receipt mentions the data source + algorithm.
    assert "real" in out["bodyText"].lower() or "bfs" in out["bodyText"].lower()
    assert "hdbscan" in out["bodyText"].lower()
    assert out["hasCopyBtn"] is True


# ── bridge-analysis ────────────────────────────────────────────────────


def test_bridge_analysis_empty_with_one_level(page):
    """With only one clustering level (the BFS-5000 default), the
    bridge panel shows an empty-state hint."""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/bridge-analysis.js");
            const state = await import("/app/src/ui/state.js");
            mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 100));
            return {
                emptyText: host.querySelector(".panel-bridge-empty")?.textContent,
                table:     !!host.querySelector(".panel-bridge-table"),
            };
        }'''
    )
    assert out["emptyText"] is not None
    assert "two" in out["emptyText"].lower() or "level" in out["emptyText"].lower()
    assert out["table"] is False


# ── bootstrap-stability ────────────────────────────────────────────────


def test_bootstrap_stability_live_run(page):
    """Mount in live mode, run a small bootstrap (B=5 to keep it
    fast), verify per-cluster table + aggregates appear. Save-this-run
    button shows after a successful run."""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/bootstrap-stability.js");
            const state = await import("/app/src/ui/state.js");
            mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 100));
            // Lower B to 5 for speed; bootstrap-Jaccard at n=5000 ~5s/iter.
            const bSlider = host.querySelectorAll('input[type="range"]')[0];
            bSlider.value = "5"; bSlider.dispatchEvent(new Event("input"));
            // Click Run.
            host.querySelector(".panel-bs-run").click();
            // Poll for completion.
            for (let i = 0; i < 200; i++) {
                await new Promise(r => setTimeout(r, 500));
                const status = host.querySelector(".panel-bs-status")?.textContent || "";
                if (status.includes("iters")) break;
            }
            return {
                statusText: host.querySelector(".panel-bs-status")?.textContent,
                aggStrip:   !!host.querySelector(".panel-bs-agg"),
                tableRows:  host.querySelectorAll(".panel-bs-row").length,
                saveBtn:    !!host.querySelector(".panel-bs-save"),
            };
        }'''
    )
    assert "iters" in (out["statusText"] or "")
    assert out["aggStrip"] is True
    assert out["tableRows"] > 0
    assert out["saveBtn"] is True


# ── fusion-comparison helpers ──────────────────────────────────────────


def test_nmi_helper(page):
    """Pure NMI computation. Doesn't need data."""
    out = page.evaluate(
        '''async () => {
            const { normalisedMutualInformation, adjustedMutualInformation } =
                await import("/app/src/eval/nmi.js");
            const A = new Int32Array([0,0,0,1,1,1,2,2,2]);
            const B = new Int32Array([0,0,0,1,1,1,2,2,2]);
            const C = new Int32Array([2,2,2,0,0,0,1,1,1]);    // relabelled
            const D = new Int32Array([0,1,2,0,1,2,0,1,2]);    // independent
            return {
                identical: normalisedMutualInformation(A, B).nmi_arith,
                permuted:  normalisedMutualInformation(A, C).nmi_arith,
                indep:     normalisedMutualInformation(A, D).nmi_arith,
                ami:       adjustedMutualInformation(A, B).ami,
            };
        }'''
    )
    assert abs(out["identical"] - 1.0) < 1e-6
    assert abs(out["permuted"]  - 1.0) < 1e-6
    assert out["indep"] < 0.3
    assert abs(out["ami"] - 1.0) < 1e-3


def test_compare_partitions_hand_crafted(page):
    out = page.evaluate(
        '''async () => {
            const { compareFusionPartitions } = await import("/app/src/eval/fusion-compare.js");
            const pre  = { nodeCluster: new Int32Array([0,0,0,0, 1,1,1,1, 2,2,2,2]),
                           clusters: [{id:0},{id:1},{id:2}] };
            const post = { nodeCluster: new Int32Array([0,0,0,2, 1,1,1,1, 2,2,2,1]),
                           clusters: [{id:0},{id:1},{id:2}] };
            const r = compareFusionPartitions(pre, post);
            return {
                ari:   r.aggregate.ari,
                nmi:   r.aggregate.nmi_arith,
                macro: r.aggregate.macroJaccard,
                pre:   r.aggregate.nClustersPre,
                post:  r.aggregate.nClustersPost,
                top:   r.topMovers[0],
                len:   r.perNodeRetention.length,
            };
        }'''
    )
    assert 0.5 < out["ari"] < 1.0
    assert 0.5 < out["macro"] < 1.0
    assert out["pre"] == 3 and out["post"] == 3
    assert out["len"] == 12
    assert out["top"]["retention"] < 0.5


def test_fusion_comparison_panel_empty_when_no_prefusion(page):
    """BFS-5000 with default identity fusion → clusterLevelsPreFusion
    is null → panel shows empty hint."""
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/fusion-comparison.js");
            const state = await import("/app/src/ui/state.js");
            mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 100));
            return {
                title: host.querySelector(".panel-fc-title")?.textContent,
                emptyText: host.querySelector(".panel-fc-empty")?.textContent,
                hasAgg: !!host.querySelector(".panel-fc-agg"),
            };
        }'''
    )
    assert out["title"] == "Fusion comparison"
    assert out["emptyText"] is not None
    assert "non-identity fusion" in out["emptyText"]
    assert out["hasAgg"] is False


def test_fusion_comparison_panel_with_synthetic_prefusion(page):
    """Inject a synthetic clusterLevelsPreFusion (permuted labels of
    the current clustering) and verify the panel renders aggregate +
    table + movers."""
    out = page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const s = state.getState();
            const postCr = s.clusterLevels[0].clusterResult;
            const n = postCr.nodeCluster.length;
            const ids = [...new Set(Array.from(postCr.nodeCluster))].filter(x => x >= 0).sort((a,b)=>a-b);
            // Synthetic pre = post with every 10th label cycled.
            const preNodes = new Int32Array(n);
            for (let i = 0; i < n; i++) {
                let lab = postCr.nodeCluster[i];
                if (lab >= 0 && i % 10 === 0 && ids.length > 1) {
                    lab = ids[(ids.indexOf(lab) + 1) % ids.length];
                }
                preNodes[i] = lab;
            }
            state.update({
                clusterLevelsPreFusion: [{
                    uid: "synth", scope: "global",
                    clusterResult: {
                        method: postCr.method, params: postCr.params,
                        nodeCluster: preNodes,
                        clusters: ids.map(id => ({ id, indices: [] })),
                    },
                }],
            });
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/fusion-comparison.js");
            mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 200));
            return {
                agg:      host.querySelector(".panel-fc-agg")?.textContent?.replace(/\\s+/g, " ").trim(),
                rows:     host.querySelectorAll(".panel-fc-row").length,
                movers:   host.querySelectorAll(".panel-fc-mover-row").length,
            };
        }'''
    )
    assert out["agg"] is not None
    assert "ARI" in out["agg"]
    assert out["rows"] > 0
    assert out["movers"] > 0


# ── dim-sweep panel + chart helpers ────────────────────────────────────


def test_chart_helpers_render(page):
    """heatmap + bars helpers produce SVG output. No data needed."""
    out = page.evaluate(
        '''async () => {
            const heatHost = document.createElement("div");
            const barsHost = document.createElement("div");
            document.body.appendChild(heatHost);
            document.body.appendChild(barsHost);
            const { renderHeatmap } = await import("/app/src/ui/charts/heatmap.js");
            const { renderBars }    = await import("/app/src/ui/charts/bars.js");
            renderHeatmap(heatHost, {
                matrix:    [[1.0, 0.7], [0.7, 1.0]],
                rowLabels: ["d=2", "d=3"],
                colLabels: ["d=2", "d=3"],
                palette:   "ari",
            });
            renderBars(barsHost, {
                values: [50, 55],
                errors: [2, 3],
                labels: ["d=2", "d=3"],
                yLabel: "n clusters",
            });
            return {
                heatCells:    heatHost.querySelectorAll(".chart-heatmap-cell").length,
                heatOverlays: heatHost.querySelectorAll(".chart-heatmap-overlay").length,
                bars:         barsHost.querySelectorAll(".chart-bars-rect").length,
                whiskers:     barsHost.querySelectorAll(".chart-bars-whisker").length,
            };
        }'''
    )
    assert out["heatCells"] == 4
    assert out["heatOverlays"] == 4
    assert out["bars"] == 2
    assert out["whiskers"] == 2


def test_dim_sweep_runner_tiny(page):
    """Run a 2-dim × 1-seed sweep on BFS-5000. Pure runner exercise
    (no panel). Expected: ariMatrix has the expected keys, diagonals
    are 1.0. Takes ~30-60s (two UMAP-100 fits + two HDBSCAN passes)."""
    out = page.evaluate(
        '''async () => {
            const { runDimSweep } = await import("/app/src/eval/dim-sweep.js");
            const state = await import("/app/src/ui/state.js");
            const s = state.getState();
            const result = await runDimSweep({
                input:     { n: s.genResult.nodes.length, d: s.embedding.d, data: s.embedding.data },
                genResult: s.genResult,
                dims:  [50, 100],
                seeds: [42],
                noise:        { method: "pca",      params: { n_components: 100 } },
                compression:  { method: "umap",     params: { n_neighbors: 50, min_dist: 0, metric: "cosine" } },
                clustering:   { method: "hdbscan",  params: { minClusterSize: 15, minSamples: 5, selectionMethod: "eom", selectionEpsilon: 0, noiseMode: "absorb" } },
            });
            return {
                dims:  result.dims,
                seeds: result.seeds,
                diag50:  result.ariMatrix[50][50].mean,
                diag100: result.ariMatrix[100][100].mean,
                cross:   result.ariMatrix[50][100].mean,
                runtimeSec: result.runtimeSec,
            };
        }'''
    )
    assert out["dims"] == [50, 100]
    assert abs(out["diag50"] - 1.0) < 1e-6
    assert abs(out["diag100"] - 1.0) < 1e-6
    assert 0 <= out["cross"] <= 1


def test_dim_sweep_panel_mounts(page):
    out = page.evaluate(
        '''async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/dim-sweep.js");
            const state = await import("/app/src/ui/state.js");
            mount(host, state.getState(), {});
            await new Promise(r => setTimeout(r, 100));
            return {
                title:        host.querySelector(".panel-ds-title")?.textContent,
                sections:     host.querySelectorAll(".panel-ds-section").length,
                runBtn:       !!host.querySelector(".panel-ds-run"),
                estimate:     !!host.querySelector(".panel-ds-estimate"),
            };
        }'''
    )
    assert out["title"] == "Dim sweep — live"
    assert out["sections"] >= 3
    assert out["runBtn"] is True
    assert out["estimate"] is True


def test_dim_sweep_panel_saved_mode(page):
    """Saved-mode render: inject a synthetic dimSweep ValidationRun
    and verify the panel renders the heatmap + bars + verdict banner."""
    out = page.evaluate(
        '''async () => {
            const state = await import("/app/src/ui/state.js");
            const sweep = {
                dims: [50, 100],
                seeds: [42],
                inputs: { noise: { method: "pca" }, compression: { method: "umap" }, clustering: { method: "hdbscan" } },
                partitions: { 42: {
                    50:  { nodeCluster: new Int32Array(5000), nClusters: 30, timeSec: 30 },
                    100: { nodeCluster: new Int32Array(5000), nClusters: 32, timeSec: 35 },
                }},
                ariMatrix: {
                    50:  { 50: {mean:1.0,sd:0,perSeed:[1.0]},   100: {mean:0.78,sd:0,perSeed:[0.78]} },
                    100: { 50: {mean:0.78,sd:0,perSeed:[0.78]}, 100: {mean:1.0,sd:0,perSeed:[1.0]} },
                },
                clusterCounts: {
                    50:  { mean: 30, sd: 0, perSeed: [30] },
                    100: { mean: 32, sd: 0, perSeed: [32] },
                },
                runtimeSec: 65, completedAt: new Date().toISOString(),
            };
            const id = state.saveValidationRun({
                type: "dimSweep",
                label: "synthetic dim sweep",
                inputs: { dataSourceId: "real", dataSourceConfig: { subset: "dev_subset_bfs_5000" }, layerParamsSnapshot: state.getState().layerParams },
                settings: { dims: [50, 100], seeds: [42], verdictPair: [50, 100], verdictThreshold: 0.9 },
                results:  { sweep, verdict: { pair: [50, 100], threshold: 0.9, mean: 0.78, sd: 0, defensible: false } },
                scoreVersion: 1, runtimeSec: 65, branchId: null,
            });
            const host = document.createElement("div");
            document.body.appendChild(host);
            const { mount } = await import("/app/src/ui/panels/dim-sweep.js");
            mount(host, state.getState(), { runId: id });
            await new Promise(r => setTimeout(r, 200));
            return {
                title:        host.querySelector(".panel-ds-title")?.textContent,
                bannerText:   host.querySelector(".panel-ds-verdict-banner")?.textContent,
                heatmapCells: host.querySelectorAll(".chart-heatmap-cell").length,
                bars:         host.querySelectorAll(".chart-bars-rect").length,
                hasRunBtn:    !!host.querySelector(".panel-ds-run"),
                hasSaveBtn:   !!host.querySelector(".panel-ds-save"),
            };
        }'''
    )
    assert out["title"] == "synthetic dim sweep"
    assert "FAIL" in out["bannerText"]
    assert out["heatmapCells"] == 4
    assert out["bars"] == 2
    assert out["hasRunBtn"] is False
    assert out["hasSaveBtn"] is False
