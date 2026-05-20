"""Regression test for the bug:

When alignedCitationLayout is null (no citation layout applied yet),
the blend hook used to bail entirely — so the fusion slider had no
effect on the viewer. Fix: blend hook now computes the fusion-aware
basePos even without citation layout, just skipping the outer blend.

Test at toy scale (fast): fake _basePosPreFusion at known offsets,
run the blend hook with alignedCitationLayout = null, vary fusionBlend,
confirm node positions change.
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

        # Boot done. Now: inject fake _basePos + _basePosPreFusion,
        # leave alignedCitationLayout = null, run the blend hook.
        out = page.evaluate(
            '''async () => {
                const state = await import("/app/src/ui/state.js");
                const blendMod = await import("/app/src/blend/blend.js");

                // Synthetic basePos / basePosPre at distinct positions.
                const bp    = new Float32Array([ 10, 0, 0,  20, 0, 0,  30, 0, 0]);
                const bpPre = new Float32Array([-10, 0, 0, -20, 0, 0, -30, 0, 0]);

                state.update({
                    _basePos:              bp,
                    _basePosPreFusion:     bpPre,
                    alignedCitationLayout: null,  // KEY: no citation layout
                    blend:    0.5,                // any value — outer blend should be ignored
                    fusionBlend: 1.0,
                });

                const force = blendMod.makeBlendForce({
                    getBasePos:            () => state.getState()._basePos,
                    getBasePosPreFusion:   () => state.getState()._basePosPreFusion,
                    getAlignedCitationPos: () => state.getState().alignedCitationLayout,
                    getBlend:              () => state.getState().blend,
                    getFusionBlend:        () => state.getState().fusionBlend,
                });

                const nodes = [
                    { id: 0, kind: "node", x: 0, y: 0, z: 0 },
                    { id: 1, kind: "node", x: 0, y: 0, z: 0 },
                    { id: 2, kind: "node", x: 0, y: 0, z: 0 },
                ];
                force.initialize(nodes);

                // fb = 1.0 → expect post-fusion (bp).
                state.update({ fusionBlend: 1.0 });
                force();
                const atFb1 = nodes.map(n => [n.x, n.y, n.z]);

                // fb = 0.0 → expect pre-fusion (bpPre).
                state.update({ fusionBlend: 0.0 });
                force();
                const atFb0 = nodes.map(n => [n.x, n.y, n.z]);

                // fb = 0.5 → expect midpoint.
                state.update({ fusionBlend: 0.5 });
                force();
                const atFb05 = nodes.map(n => [n.x, n.y, n.z]);

                return { atFb1, atFb0, atFb05 };
            }'''
        )

        print("with alignedCitationLayout = null:")
        for k, v in out.items():
            print(f"  {k:<10} {v}")

        # Expected:
        #   atFb1  → bp:    [10,0,0] [20,0,0] [30,0,0]
        #   atFb0  → bpPre: [-10,0,0] [-20,0,0] [-30,0,0]
        #   atFb05 → mid:   [0,0,0]  [0,0,0]  [0,0,0]
        expected_fb1 = [[10, 0, 0], [20, 0, 0], [30, 0, 0]]
        expected_fb0 = [[-10, 0, 0], [-20, 0, 0], [-30, 0, 0]]
        expected_fb05 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]

        ok1 = out["atFb1"] == expected_fb1
        ok0 = out["atFb0"] == expected_fb0
        ok05 = out["atFb05"] == expected_fb05

        print(f"\n  fb=1 matches post-fusion: {ok1}")
        print(f"  fb=0 matches pre-fusion:  {ok0}")
        print(f"  fb=0.5 matches midpoint:  {ok05}")
        print(f"\n  RESULT: {'PASS' if (ok1 and ok0 and ok05) else 'FAIL'}")

        print(f"\nerrors: {len(errs)}")
        for t, m in errs[:5]: print(f"  [{t}] {m}")
        b.close()


if __name__ == "__main__":
    main()
