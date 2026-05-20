"""Reproduce the user's exact path:
  1. Boot toy
  2. Switch to BFS-5000 real source
  3. Wait for redimred to complete (needs viz=UMAP-3 picked)
  4. Run clustering (the user's failing step)

Times everything, reports worker spawns, errors.
"""
from playwright.sync_api import sync_playwright

URL = "http://localhost:8000/app/"


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        errs = []
        page.on("pageerror", lambda e: errs.append(("PAGE_ERROR", str(e))))
        page.on("console", lambda m: errs.append((m.type, m.text)) if m.type in ("error",) else None)

        worker_calls = []
        page.on(
            "request",
            lambda r: worker_calls.append(r.url)
            if "/workers/" in r.url and r.url.endswith("-worker.js") else None,
        )

        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(3000)
        print(f"── boot done. worker calls so far: {len(worker_calls)}")

        # === Switch to BFS-5000 with UMAP-3 viz + UMAP-50 compression. ===
        print(f"\n── switching to BFS-5000 ──")
        outcome = page.evaluate(
            '''async () => {
                const t0 = performance.now();
                const engine = await import("/app/src/ui/engine.js");
                const state = await import("/app/src/ui/state.js");
                const dimredReg = await import("/app/src/dimred/registry.js");

                // Set data source to real BFS-5000.
                const s = state.getState();
                state.update({
                    activeAlgorithm: { ...s.activeAlgorithm, dataSource: "real" },
                    dataSource: {
                        ...s.dataSource,
                        method: "real",
                        configs: {
                            ...(s.dataSource.configs || {}),
                            real: { subset: "dev_subset_bfs_5000" },
                        },
                    },
                });

                // Set dim-reduction: PCA-100 noise, UMAP-50 compression, UMAP-3 viz.
                const pca = dimredReg.getAlgorithm("pca");
                const umap = dimredReg.getAlgorithm("umap");
                const ident = dimredReg.getAlgorithm("identity");
                state.update({
                    layerParams: {
                        ...state.getState().layerParams,
                        dimred: {
                            noise:       { method: "pca",  params: pca.defaultParamsForSlot("noise") },
                            fusion:      { method: "identity", params: ident.defaultParams() },
                            compression: { method: "umap", params: umap.defaultParamsForSlot("compression") },
                            viz:         { method: "umap", params: umap.defaultParamsForSlot("viz") },
                            viz2d:       { method: "umap", params: umap.defaultParamsForSlot("viz2d") },
                        },
                    },
                });

                try {
                    await engine.reingest();
                    const t1 = performance.now();
                    const s2 = state.getState();
                    return {
                        ok: true,
                        elapsedSec: ((t1 - t0)/1000).toFixed(1),
                        nNodes: s2.genResult ? s2.genResult.nodes.length : 0,
                        hasBasePos: !!s2._basePos,
                        nClusters: s2.clusterResult ? s2.clusterResult.clusters.length : -1,
                    };
                } catch (e) {
                    return { ok: false, error: e.message, stack: e.stack };
                }
            }'''
        )
        print(f"  outcome: {outcome}")
        print(f"  worker calls during reingest+redimred+recluster: {len(worker_calls)}")
        for u in worker_calls: print(f"    + {u.split('/')[-1]}")

        # === Now explicitly trigger recluster (the user's failing step). ===
        print(f"\n── explicit recluster() (user's failing step) ──")
        outcome = page.evaluate(
            '''async () => {
                const t0 = performance.now();
                try {
                    const engine = await import("/app/src/ui/engine.js");
                    await engine.recluster();
                    const t1 = performance.now();
                    const s = (await import("/app/src/ui/state.js")).getState();
                    return {
                        ok: true,
                        elapsedSec: ((t1 - t0)/1000).toFixed(1),
                        nClusters: s.clusterResult ? s.clusterResult.clusters.length : -1,
                        nLevels: s.clusterLevels ? s.clusterLevels.length : 0,
                    };
                } catch (e) {
                    return { ok: false, error: e.message, stack: e.stack };
                }
            }'''
        )
        print(f"  outcome: {outcome}")

        print(f"\n── errors: {len(errs)}")
        for t, m in errs[:10]: print(f"  [{t}] {m[:300]}")
        b.close()


if __name__ == "__main__":
    main()
