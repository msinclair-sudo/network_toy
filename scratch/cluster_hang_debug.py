"""Reproduce the user's 'clustering hangs' report.

Boots, then drives the clustering modal Apply path the way a user
would (Configure tab → Apply button). Captures everything in worker
land: spawns, messages, errors. Reports whether the worker ever
returns a result.
"""
from playwright.sync_api import sync_playwright

URL = "http://localhost:8000/app/"


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True)
        ctx = b.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        page_errors = []
        console_msgs = []
        worker_urls = []

        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.on("console", lambda m: console_msgs.append(f"[{m.type}] {m.text}"))
        page.on(
            "request",
            lambda r: worker_urls.append(r.url)
            if "/workers/" in r.url and r.url.endswith("-worker.js") else None,
        )

        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(3000)

        print(f"── boot done. spawns so far: {len(worker_urls)}")
        boot_spawns = list(worker_urls)

        # Drive recluster() explicitly from the page (mimics what the
        # modal does — descriptor.applyChange writes to layerParams then
        # awaits engine.recluster()). We invoke the lane directly and
        # wait on its promise so we can see if it ever resolves.
        before_state = page.evaluate(
            '''async () => {
                const s = (await import("/app/src/ui/state.js")).getState();
                return {
                  clusterMethod: s.layerParams.clustering && s.layerParams.clustering.method,
                  nLevels: s.clusterLevels ? s.clusterLevels.length : 0,
                  nClusters: s.clusterResult ? s.clusterResult.clusters.length : -1,
                };
            }'''
        )
        print(f"  pre-apply state: {before_state}")

        # Now run recluster() and time it.
        print(f"\n── invoking engine.recluster() directly ──")
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
                    elapsedMs: t1 - t0,
                    nLevels: s.clusterLevels ? s.clusterLevels.length : 0,
                    nClusters: s.clusterResult ? s.clusterResult.clusters.length : -1,
                  };
                } catch (e) {
                  return { ok: false, error: e.message, stack: e.stack };
                }
            }'''
        )
        print(f"  outcome: {outcome}")

        new_spawns = [u for u in worker_urls if u not in boot_spawns]
        print(f"\n  new worker spawns during recluster: {len(new_spawns)}")
        for u in new_spawns:
            print(f"    + {u}")

        print(f"\n── page errors: {len(page_errors)}")
        for e in page_errors:
            print(f"    ! {e}")

        # Console output — filter for interesting things.
        interesting = [m for m in console_msgs
                       if m.startswith("[error]") or "worker" in m.lower() or "fail" in m.lower()]
        print(f"\n── notable console messages: {len(interesting)}")
        for m in interesting[:20]:
            print(f"    · {m}")

        b.close()


if __name__ == "__main__":
    main()
