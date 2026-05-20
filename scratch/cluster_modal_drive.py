"""Drive the clustering modal the way the user would. Open via the
workflow chart 'Clustering' node, hit Apply on the Configure tab,
watch what happens to state and the modal.
"""
from playwright.sync_api import sync_playwright

URL = "http://localhost:8000/app/"


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(headless=False, slow_mo=200)
        ctx = b.new_context(viewport={"width": 1400, "height": 900})
        page = ctx.new_page()

        page_errors = []
        page.on("pageerror", lambda e: page_errors.append(str(e)))
        page.on("console", lambda m: print(f"  [{m.type}] {m.text}") if m.type in ("error", "warning") else None)

        page.goto(URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(3000)

        # Find the Clustering node in the workflow chart and click it.
        # nodes have role-like classes — let's find the right one.
        nodes = page.locator("#workflow-chart .wf-node-rect")
        count = nodes.count()
        print(f"workflow chart nodes: {count}")

        # The clustering node's label should contain 'Clustering'. Open the
        # workflow chart's text labels and find the matching one.
        for i in range(count):
            label = page.locator("#workflow-chart .wf-node-label").nth(i).text_content() if page.locator("#workflow-chart .wf-node-label").count() > i else ""
            print(f"  node {i}: label={label!r}")

        # Just click the clustering one by finding label text.
        cluster_node = page.locator("#workflow-chart text", has_text="Clustering").first
        if cluster_node.count() > 0:
            cluster_node.click()
            print("clicked Clustering node")
        else:
            print("ERROR: Clustering node not found")
            b.close()
            return

        page.wait_for_timeout(500)
        # Modal should be open. Hit Apply.
        apply_btn = page.locator(".modal-action.primary")
        if apply_btn.count() > 0:
            print(f"Apply button found. Clicking...")
            apply_btn.click()
            # Wait a few seconds, see what happens.
            page.wait_for_timeout(5000)
            modal_open = page.locator(".modal-backdrop").count() > 0
            print(f"After 5s wait: modal still open? {modal_open}")
        else:
            print("ERROR: Apply button not found")

        state = page.evaluate(
            '''async () => {
                const s = (await import("/app/src/ui/state.js")).getState();
                return {
                  nClusters: s.clusterResult ? s.clusterResult.clusters.length : -1,
                  layerState: s.layerStates,
                };
            }'''
        )
        print(f"final state: {state}")
        print(f"page errors: {len(page_errors)}")
        for e in page_errors: print(f"  ! {e}")

        b.close()


if __name__ == "__main__":
    main()
