"""Test fusion + pre-fusion state population.

Run the cascade with graph-diffusion fusion turned on and verify
state._basePosPreFusion gets populated (which is what makes the
fusion slider visible).
"""
from playwright.sync_api import sync_playwright

URL = "http://localhost:8000/app/"


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        page = b.new_context().new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(("PAGE", str(e))))
        page.on("console", lambda m: errs.append((m.type, m.text[:300])) if m.type == "error" else None)

        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(3000)

        out = page.evaluate(
            '''async () => {
                const t0 = performance.now();
                const engine = await import("/app/src/ui/engine.js");
                const state = await import("/app/src/ui/state.js");
                const dimredReg = await import("/app/src/dimred/registry.js");

                // Switch to real BFS-5000 and turn on fusion.
                const s0 = state.getState();
                state.update({
                    activeAlgorithm: { ...s0.activeAlgorithm, dataSource: "real" },
                    dataSource: {
                        ...s0.dataSource,
                        method: "real",
                        configs: { ...(s0.dataSource.configs || {}), real: { subset: "dev_subset_bfs_5000" } },
                    },
                });
                const pca = dimredReg.getAlgorithm("pca");
                const umap = dimredReg.getAlgorithm("umap");
                const gd = dimredReg.getAlgorithm("graph-diffusion");
                state.update({
                    layerParams: {
                        ...state.getState().layerParams,
                        dimred: {
                            noise:       { method: "pca",  params: pca.defaultParamsForSlot("noise") },
                            fusion:      { method: "graph-diffusion", params: gd.defaultParamsForSlot("fusion") },
                            compression: { method: "umap", params: umap.defaultParamsForSlot("compression") },
                            viz:         { method: "umap", params: umap.defaultParamsForSlot("viz") },
                            viz2d:       { method: "umap", params: umap.defaultParamsForSlot("viz2d") },
                        },
                    },
                });

                try {
                    await engine.reingest();
                    const t1 = performance.now();
                    const s = state.getState();
                    return {
                        ok: true,
                        elapsedSec: ((t1-t0)/1000).toFixed(1),
                        n: s.genResult.nodes.length,
                        hasBasePos: !!s._basePos,
                        hasBasePosPreFusion: !!s._basePosPreFusion,
                        basePosLen: s._basePos ? s._basePos.length : -1,
                        basePosPreLen: s._basePosPreFusion ? s._basePosPreFusion.length : -1,
                        hasDimred: !!s.dimredResult,
                        hasDimredPre: !!s.dimredResultPreFusion,
                        hasClusters: !!s.clusterResult,
                        hasClustersPre: !!s.clusterResultPreFusion,
                    };
                } catch (e) {
                    return { ok: false, error: e.message, stack: (e.stack||"").slice(0,500) };
                }
            }'''
        )
        print(f"outcome: {out}")
        print(f"errors: {len(errs)}")
        for t, m in errs[:10]:
            print(f"  [{t}] {m}")
        b.close()


if __name__ == "__main__":
    main()
