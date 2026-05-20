"""Slice 3 of §6.11 — layout worker.

Boot the toy + cascade (exercises Slices 1+2: dimred + clustering
workers). Since §6.16 made citation layout opt-in, the cascade stops
before relayoutCitations; we trigger it explicitly from the page
context. Then:
  1. Confirm a layout-worker spawn happens.
  2. Confirm state.citationLayout (Float32Array) + alignedCitationLayout
     + alignmentCorrelation populate after the apply.
  3. Confirm no JS errors.
"""
from playwright.sync_api import sync_playwright

URL = "http://localhost:8000/app/"
KNOWN_FG_TEARDOWN = "Cannot read properties of undefined (reading 'tick')"


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        page_errors = []
        console_errs = []
        worker_urls = []

        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.on(
            "console",
            lambda m: console_errs.append(f"[{m.type}] {m.text}")
            if m.type == "error" else None,
        )
        page.on(
            "request",
            lambda r: worker_urls.append(r.url)
            if "/workers/" in r.url and r.url.endswith("-worker.js") else None,
        )

        # ── Boot. Exercises Slices 1+2 (dimred + clustering workers).
        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(3000)

        pre_apply_spawns = list(worker_urls)
        boot_state = page.evaluate(
            '''async () => {
                const s = (await import("/app/src/ui/state.js")).getState();
                return {
                  hasCitations: !!(s.citationResult && s.citationResult.citations),
                  citationCount: s.citationResult && s.citationResult.citations
                    ? s.citationResult.citations.length : 0,
                  hasLayout: !!s.citationLayout,
                };
            }'''
        )

        # ── Trigger relayoutCitations explicitly.
        # Engine module exports it as an async function; we await it from
        # the page context. Use the same module-import pattern the smoke
        # tests use for state access.
        apply_outcome = page.evaluate(
            '''async () => {
                const engine = await import("/app/src/ui/engine.js");
                await engine.relayoutCitations();
                const s = (await import("/app/src/ui/state.js")).getState();
                const cl = s.citationLayout;
                const acl = s.alignedCitationLayout;
                return {
                  hasLayout:  !!cl,
                  layoutLen:  cl ? cl.length : -1,
                  hasAligned: !!acl,
                  alignedLen: acl ? acl.length : -1,
                  correlation: s.alignmentCorrelation,
                };
            }'''
        )

        post_apply_spawns = list(worker_urls)
        new_spawns = post_apply_spawns[len(pre_apply_spawns):]

        errs = [e for e in page_errors if KNOWN_FG_TEARDOWN not in e]

        dimred_spawns  = [u for u in pre_apply_spawns  if "dimred-worker" in u]
        cluster_spawns = [u for u in pre_apply_spawns  if "clustering-worker" in u]
        layout_spawns  = [u for u in new_spawns        if "layout-worker"     in u]

        print(f"── boot ──────────────────────────────")
        print(f"  page errors:           {len(errs)}")
        for e in errs: print(f"    ! {e}")
        print(f"  console errors:        {len(console_errs)}")
        for e in console_errs: print(f"    · {e}")
        print(f"  spawns before apply:   {len(pre_apply_spawns)}")
        print(f"    dimred-worker:         {len(dimred_spawns)}")
        print(f"    clustering-worker:     {len(cluster_spawns)}")
        print(f"  boot state:")
        for k, v in boot_state.items(): print(f"    {k:<20} {v}")

        print(f"\n── after relayoutCitations apply ─────")
        print(f"  spawns since apply:    {len(new_spawns)}")
        print(f"    layout-worker:         {len(layout_spawns)}")
        print(f"  post-apply state:")
        for k, v in apply_outcome.items(): print(f"    {k:<20} {v}")

        ok = (
            len(errs) == 0
            and boot_state["hasCitations"]
            and len(dimred_spawns) >= 5
            and len(cluster_spawns) >= 1
            and len(layout_spawns) >= 1
            and apply_outcome["hasLayout"]
            and apply_outcome["hasAligned"]
            and apply_outcome["alignedLen"] > 0
        )
        print(f"\n  RESULT: {'PASS' if ok else 'FAIL'}")
        b.close()


if __name__ == "__main__":
    main()
