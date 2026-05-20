"""Reproduce the user's exact failing path:
  1. Boot
  2. Switch to BFS-5000 + UMAP-3/UMAP-50 dimred
  3. Switch clustering to HDBSCAN
  4. Run recluster() and time it.

If HDBSCAN at n=5000 truly takes long enough to look like a hang,
we'll find out here. If it never finishes / throws inside the worker,
also.
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
        page.on("console", lambda m: errs.append((m.type, m.text[:300])) if m.type in ("error",) else None)

        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(3000)

        # --- 1. Boot + switch to BFS-5000 (no clustering yet, leave default) ---
        print("── switching to BFS-5000 + UMAP cascade ──")
        out1 = page.evaluate(
            '''async () => {
                const t0 = performance.now();
                const engine = await import("/app/src/ui/engine.js");
                const state = await import("/app/src/ui/state.js");
                const dimredReg = await import("/app/src/dimred/registry.js");
                const s = state.getState();
                state.update({
                    activeAlgorithm: { ...s.activeAlgorithm, dataSource: "real" },
                    dataSource: {
                        ...s.dataSource,
                        method: "real",
                        configs: { ...(s.dataSource.configs || {}), real: { subset: "dev_subset_bfs_5000" } },
                    },
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
                const s2 = state.getState();
                return {
                    elapsedSec: ((t1-t0)/1000).toFixed(1),
                    n: s2.genResult.nodes.length,
                    nClusters_default: s2.clusterResult.clusters.length,
                };
            }'''
        )
        print(f"  {out1}")

        # --- 2. Now switch to HDBSCAN and recluster (the user's step) ---
        print("\n── recluster with HDBSCAN ──")
        out2 = page.evaluate(
            '''async () => {
                const t0 = performance.now();
                const engine = await import("/app/src/ui/engine.js");
                const state = await import("/app/src/ui/state.js");
                const reg = await import("/app/src/clustering-registry.js");
                const hdb = reg.getAlgorithm("hdbscan");
                const cfg = {
                    method: "hdbscan",
                    levels: [{ uid: "L0", params: hdb.defaultParams(), scope: "global" }],
                };
                const s = state.getState();
                state.update({ layerParams: { ...s.layerParams, clustering: cfg } });
                try {
                    await engine.recluster();
                    const t1 = performance.now();
                    const s2 = state.getState();
                    return {
                        ok: true,
                        elapsedSec: ((t1-t0)/1000).toFixed(1),
                        nClusters: s2.clusterResult.clusters.length,
                    };
                } catch (e) {
                    return { ok: false, error: e.message, stack: (e.stack||"").slice(0,500) };
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
