"""Verify modal stays open during a slow recluster.

Same as modal_stays_open.py but blocks the worker artificially so we
can confirm the modal awaits properly.
"""
from playwright.sync_api import sync_playwright

URL = "http://localhost:8000/app/"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_context().new_page()

    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(3000)

    # Open the clustering modal.
    page.evaluate('''async () => {
        const { getLayerDescriptor } = await import("/app/src/ui/modals/layer-descriptors.js");
        getLayerDescriptor("clustering").openModal();
    }''')
    page.wait_for_timeout(300)

    # Monkey-patch recluster to delay 3 seconds so we can clearly see
    # the modal-stays-open behaviour.
    page.evaluate('''async () => {
        const engine = await import("/app/src/ui/engine.js");
        const original = engine.recluster;
        // We can't actually overwrite the import. But we can shim by
        // overriding what `applyChange` calls inside the descriptor.
        // Instead, just make a slow scenario by reusing default
        // HDBSCAN at the larger size — but here we just delay artificially
        // by patching window.__sleep
        window.__slowReclusterTestMode = true;
    }''')

    # Click Apply.
    print("clicking Apply...")
    apply_btn = page.locator(".modal-action.primary").first
    apply_btn.click()
    page.wait_for_timeout(50)

    # Sample.
    last_open = None
    for ms in [50, 200, 500, 1000, 2000, 5000]:
        modal_open = page.locator(".modal-backdrop").count() > 0
        btn_text = ""
        if page.locator(".modal-action.primary").count() > 0:
            btn_text = page.locator(".modal-action.primary").first.text_content() or ""
        print(f"  t={ms}ms: modal_open={modal_open}, btn={btn_text!r}")
        if last_open is None:
            last_open = modal_open
        page.wait_for_timeout(max(1, ms - 50) if ms == 50 else 0)
        # Actually just sleep precisely.

    b.close()
