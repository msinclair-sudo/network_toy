"""Test multi-level clustering, HDBSCAN, and modal-driven Apply
to find what's hanging."""
from playwright.sync_api import sync_playwright

URL = "http://localhost:8000/app/"


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        page = b.new_context().new_page()

        errs = []
        page.on("pageerror", lambda e: errs.append(("PAGE_ERROR", str(e))))
        page.on("console", lambda m: errs.append((m.type, m.text)) if m.type in ("error", "warning") else None)

        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(3000)

        # === Test 1: HDBSCAN (single level) ===
        print("── Test 1: HDBSCAN single level ──")
        outcome = page.evaluate(
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
                    return { ok: true, elapsedMs: t1 - t0,
                             nClusters: s2.clusterResult.clusters.length };
                } catch (e) { return { ok: false, error: e.message }; }
            }'''
        )
        print(f"  {outcome}")

        # === Test 2: 2-level mutualKNN ===
        print("\n── Test 2: 2-level mutualKNN (within-parent at level 2) ──")
        outcome = page.evaluate(
            '''async () => {
                const t0 = performance.now();
                const engine = await import("/app/src/ui/engine.js");
                const state = await import("/app/src/ui/state.js");
                const reg = await import("/app/src/clustering-registry.js");
                const mk = reg.getAlgorithm("mutualKNN");
                const cfg = {
                    method: "mutualKNN",
                    levels: [
                        { uid: "L0", params: { ...mk.defaultParams(), mutualK: 3 }, scope: "global" },
                        { uid: "L1", params: { ...mk.defaultParams(), mutualK: 5 }, scope: "within-parent" },
                    ],
                };
                const s = state.getState();
                state.update({ layerParams: { ...s.layerParams, clustering: cfg } });
                try {
                    await engine.recluster();
                    const t1 = performance.now();
                    const s2 = state.getState();
                    return { ok: true, elapsedMs: t1 - t0,
                             nLevels: s2.clusterLevels.length,
                             l0: s2.clusterLevels[0].clusterResult.clusters.length,
                             l1: s2.clusterLevels[1].clusterResult.clusters.length };
                } catch (e) { return { ok: false, error: e.message, stack: e.stack }; }
            }'''
        )
        print(f"  {outcome}")

        # === Test 3: 3 levels ===
        print("\n── Test 3: 3-level mutualKNN ──")
        outcome = page.evaluate(
            '''async () => {
                const t0 = performance.now();
                const engine = await import("/app/src/ui/engine.js");
                const state = await import("/app/src/ui/state.js");
                const reg = await import("/app/src/clustering-registry.js");
                const mk = reg.getAlgorithm("mutualKNN");
                const cfg = {
                    method: "mutualKNN",
                    levels: [
                        { uid: "L0", params: { mutualK: 2 }, scope: "global" },
                        { uid: "L1", params: { mutualK: 4 }, scope: "within-parent" },
                        { uid: "L2", params: { mutualK: 6 }, scope: "within-parent" },
                    ],
                };
                const s = state.getState();
                state.update({ layerParams: { ...s.layerParams, clustering: cfg } });
                try {
                    await engine.recluster();
                    const t1 = performance.now();
                    const s2 = state.getState();
                    return { ok: true, elapsedMs: t1 - t0, nLevels: s2.clusterLevels.length };
                } catch (e) { return { ok: false, error: e.message, stack: e.stack }; }
            }'''
        )
        print(f"  {outcome}")

        print(f"\nerrors / warnings: {len(errs)}")
        for t, m in errs[:5]: print(f"  [{t}] {m[:200]}")
        b.close()


if __name__ == "__main__":
    main()
