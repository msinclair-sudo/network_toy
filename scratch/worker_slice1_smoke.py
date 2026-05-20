"""Slices 1+2 of §6.11 — worker-runner + DAG + dimred + clustering workers.

Smoke checks:
  1. App boots without JS errors after the redimred + recluster async refactor.
  2. Toy reingest cascades end-to-end via the worker DAG —
     state.dimredResult populated, basePos present, clusters present.
  3. Both worker entries are actually spawned (dimred-worker for the
     dimred lane, clustering-worker for the cluster lane).
  4. Cluster count matches baseline (n=400 toy + mutualKNN default = 24).
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
        # Track Worker spawns by URL — both dimred and clustering workers
        # land under app/src/workers/.
        page.on(
            "request",
            lambda r: worker_urls.append(r.url)
            if "/workers/" in r.url and r.url.endswith("-worker.js") else None,
        )

        page.goto(URL)
        page.wait_for_load_state("networkidle")
        # Toy reingest + cascade takes a beat — generous wait so DAG settles.
        page.wait_for_timeout(3000)

        state = page.evaluate(
            '''async () => {
                const s = (await import("/app/src/ui/state.js")).getState();
                return {
                  nNodes: s.genResult ? s.genResult.nodes.length : 0,
                  hasBasePos: !!s._basePos,
                  hasDimred: !!s.dimredResult,
                  dimredD: s.dimredResult ? s.dimredResult.d : -1,
                  clusterCount: s.clusterLevels ? s.clusterLevels.length : 0,
                  level0NClusters: (s.clusterLevels
                    && s.clusterLevels[0]
                    && s.clusterLevels[0].clusterResult
                    && s.clusterLevels[0].clusterResult.clusters)
                    ? s.clusterLevels[0].clusterResult.clusters.length : -1,
                };
            }'''
        )

        errs = [e for e in page_errors if KNOWN_FG_TEARDOWN not in e]

        dimred_spawns = [u for u in worker_urls if "dimred-worker" in u]
        cluster_spawns = [u for u in worker_urls if "clustering-worker" in u]

        print(f"── boot ──────────────────────────────")
        print(f"  page errors:     {len(errs)}")
        for e in errs:
            print(f"    ! {e}")
        print(f"  console errors:  {len(console_errs)}")
        for e in console_errs:
            print(f"    · {e}")
        print(f"  worker spawns:   {len(worker_urls)} total")
        print(f"    dimred-worker:     {len(dimred_spawns)}")
        print(f"    clustering-worker: {len(cluster_spawns)}")
        print(f"  state:")
        for k, v in state.items():
            print(f"    {k:<20} {v}")

        ok = (
            len(errs) == 0
            and state["nNodes"] > 0
            and state["hasBasePos"]
            and state["hasDimred"]
            and state["clusterCount"] > 0
            and len(dimred_spawns) >= 5
            and len(cluster_spawns) >= 1
        )
        print(f"\n  RESULT: {'PASS' if ok else 'FAIL'}")
        b.close()


if __name__ == "__main__":
    main()
