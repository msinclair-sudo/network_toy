"""Verify the clustering modal stays open while async recluster runs."""
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

        # Open clustering modal programmatically via the descriptor.
        page.evaluate(
            '''async () => {
                const { getLayerDescriptor } = await import("/app/src/ui/modals/layer-descriptors.js");
                const d = getLayerDescriptor("clustering");
                d.openModal();
                return d.label;
            }'''
        )
        page.wait_for_timeout(500)

        modal_count = page.locator(".modal-backdrop").count()
        apply_btn_count = page.locator(".modal-action.primary").count()
        print(f"after openModal: modal-backdrop={modal_count}, primary-action={apply_btn_count}")

        if apply_btn_count == 0:
            print("FAIL: no primary action found")
            b.close()
            return

        # Click Apply.
        page.locator(".modal-action.primary").first.click()
        page.wait_for_timeout(100)

        # Sample modal state at several intervals.
        for ms in [100, 300, 800, 2000, 5000]:
            page.wait_for_timeout(ms - (100 if ms == 100 else (ms - prev_ms)))
            prev_ms = ms
            modal_open = page.locator(".modal-backdrop").count() > 0
            btn_text = ""
            if page.locator(".modal-action.primary").count() > 0:
                btn_text = page.locator(".modal-action.primary").first.text_content()
            print(f"  t={ms}ms: modal_open={modal_open}, btn_text={btn_text!r}")

        b.close()


if __name__ == "__main__":
    main()
