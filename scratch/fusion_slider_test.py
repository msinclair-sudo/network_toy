"""Test: drag the fusion slider, watch node positions in the viewer.

Sequence:
  1. Boot, switch to BFS-5000, reingest with fusion=graph-diffusion.
  2. Confirm _basePosPreFusion populated.
  3. Sample a node's live position with fusionBlend=1 (default).
  4. Set fusionBlend=0 via setFusionBlend(0).
  5. Wait a beat for the viewer's blend hook to retick.
  6. Sample the same node's live position.
  7. Confirm the position CHANGED.
"""
from playwright.sync_api import sync_playwright

URL = "http://localhost:8000/app/"


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        page = b.new_context().new_page()
        errs = []
        page.on("pageerror", lambda e: errs.append(("PAGE", str(e))))
        page.on("console", lambda m: errs.append((m.type, m.text[:200])) if m.type == "error" else None)

        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(3000)

        # Switch to BFS-5000 with fusion ON, reingest.
        print("── reingest BFS-5000 with fusion ──")
        out1 = page.evaluate(
            '''async () => {
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
                await engine.reingest();
                const s = state.getState();
                return {
                    hasPre: !!s._basePosPreFusion,
                    fb: s.fusionBlend,
                    // Sample basePos and basePosPre at node 0:
                    bp0:    [s._basePos[0], s._basePos[1], s._basePos[2]],
                    bpPre0: [s._basePosPreFusion[0], s._basePosPreFusion[1], s._basePosPreFusion[2]],
                };
            }'''
        )
        print(f"  {out1}")

        if not out1.get("hasPre"):
            print("FAIL: _basePosPreFusion not populated")
            b.close()
            return

        # The blend hook lives inside the d3-force-3d simulation's tick
        # loop, which writes node.x/y/z. The HTML canvas WebGL render
        # doesn't expose those programmatically, but we can read the
        # blend function's output by calling it directly — OR just
        # verify the state slot drives a different effective basePos
        # by recomputing the lerp ourselves and comparing.
        #
        # Better: call the blend hook directly. It needs a `nodes`
        # array initialised first via .initialize(nodes).

        print("\n── direct blend-hook test (bypasses 3d-force-graph internals) ──")
        out2 = page.evaluate(
            '''async () => {
                const state = await import("/app/src/ui/state.js");
                const blendMod = await import("/app/src/blend/blend.js");
                const s = state.getState();

                const force = blendMod.makeBlendForce({
                    getBasePos:            () => state.getState()._basePos,
                    getBasePosPreFusion:   () => state.getState()._basePosPreFusion,
                    getAlignedCitationPos: () => state.getState().alignedCitationLayout,
                    getBlend:              () => state.getState().blend,
                    getFusionBlend:        () => state.getState().fusionBlend,
                });

                // Initialise with the first 3 nodes so the force has something
                // to write into.
                const nodes = [
                    { id: 0, kind: "node", x: 0, y: 0, z: 0 },
                    { id: 1, kind: "node", x: 0, y: 0, z: 0 },
                    { id: 2, kind: "node", x: 0, y: 0, z: 0 },
                ];
                force.initialize(nodes);

                // citationLayout may be null (citation layout is opt-in).
                // The blend hook bails when cp is null, so we need it set.
                // For this test, fake citationLayout = basePos so blend=0
                // means "stay at basePos".
                const fakeCit = state.getState()._basePos.slice();
                state.update({ alignedCitationLayout: fakeCit, blend: 0 });

                // Run with fusionBlend = 1.0 (default).
                state.update({ fusionBlend: 1.0 });
                force();   // ticks the force, writes node.x/y/z
                const posAtFb1 = nodes.map(n => [n.x, n.y, n.z]);

                // Run with fusionBlend = 0.0.
                state.update({ fusionBlend: 0.0 });
                force();
                const posAtFb0 = nodes.map(n => [n.x, n.y, n.z]);

                // Run with fusionBlend = 0.5.
                state.update({ fusionBlend: 0.5 });
                force();
                const posAtFb05 = nodes.map(n => [n.x, n.y, n.z]);

                return {
                    posAtFb1, posAtFb0, posAtFb05,
                    basePos0: [state.getState()._basePos[0], state.getState()._basePos[1], state.getState()._basePos[2]],
                    basePosPre0: [state.getState()._basePosPreFusion[0], state.getState()._basePosPreFusion[1], state.getState()._basePosPreFusion[2]],
                };
            }'''
        )
        for k, v in out2.items():
            print(f"  {k:<14} {v}")

        # Did the slider actually move anything?
        same_1_0 = out2["posAtFb1"][0] == out2["posAtFb0"][0]
        print(f"\n  fb=1 vs fb=0 node 0 same? {same_1_0}")
        if same_1_0:
            print("  → SLIDER HAS NO EFFECT — blend hook isn't using preFusion")
        else:
            print("  → blend hook IS using preFusion; slider works at the engine level")

        print(f"\nerrors: {len(errs)}")
        for t, m in errs[:5]: print(f"  [{t}] {m}")
        b.close()


if __name__ == "__main__":
    main()
