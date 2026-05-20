"""Test user scenario: ingest with fusion=identity first, then
toggle fusion on via redimred-only (not reingest).
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

        # === Step 1: reingest BFS-5000 with fusion=identity ===
        print("── Step 1: BFS reingest with fusion=identity ──")
        out1 = page.evaluate(
            '''async () => {
                const t0 = performance.now();
                const engine = await import("/app/src/ui/engine.js");
                const state = await import("/app/src/ui/state.js");
                const dimredReg = await import("/app/src/dimred/registry.js");

                const s0 = state.getState();
                state.update({
                    activeAlgorithm: { ...s0.activeAlgorithm, dataSource: "real" },
                    dataSource: { ...s0.dataSource, method: "real",
                                  configs: { ...(s0.dataSource.configs||{}), real: { subset: "dev_subset_bfs_5000" } } },
                });
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
                await engine.reingest();
                const t1 = performance.now();
                const s = state.getState();
                return {
                    elapsedSec: ((t1-t0)/1000).toFixed(1),
                    n: s.genResult.nodes.length,
                    hasPreFusion: !!s._basePosPreFusion,
                    fusionMethod: s.layerParams.dimred.fusion.method,
                };
            }'''
        )
        print(f"  {out1}")

        # === Step 2: NOW toggle fusion on, redimred only ===
        print("\n── Step 2: toggle fusion=graph-diffusion, redimred only ──")
        out2 = page.evaluate(
            '''async () => {
                const t0 = performance.now();
                const engine = await import("/app/src/ui/engine.js");
                const state = await import("/app/src/ui/state.js");
                const dimredReg = await import("/app/src/dimred/registry.js");
                const gd = dimredReg.getAlgorithm("graph-diffusion");
                const s = state.getState();
                state.update({
                    layerParams: {
                        ...s.layerParams,
                        dimred: {
                            ...s.layerParams.dimred,
                            fusion: { method: "graph-diffusion", params: gd.defaultParamsForSlot("fusion") },
                        },
                    },
                });
                try {
                    await engine.redimred();
                    const t1 = performance.now();
                    const s2 = state.getState();
                    return {
                        ok: true,
                        elapsedSec: ((t1-t0)/1000).toFixed(1),
                        hasPreFusion: !!s2._basePosPreFusion,
                        preFusionLen: s2._basePosPreFusion ? s2._basePosPreFusion.length : -1,
                        fusionMethod: s2.layerParams.dimred.fusion.method,
                        hasRawCitations: !!s2.rawCitationEdges,
                        rawCitCount: s2.rawCitationEdges ? s2.rawCitationEdges.length : -1,
                    };
                } catch (e) {
                    return { ok: false, error: e.message, stack: (e.stack||"").slice(0,800) };
                }
            }'''
        )
        print(f"  {out2}")

        print(f"\nerrors: {len(errs)}")
        for t, m in errs[:10]:
            print(f"  [{t}] {m}")
        b.close()


if __name__ == "__main__":
    main()
