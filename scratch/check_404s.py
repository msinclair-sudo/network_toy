"""What 404s on boot?"""
from playwright.sync_api import sync_playwright

URL = "http://localhost:8000/app/"

with sync_playwright() as p:
    b = p.chromium.launch(headless=True)
    page = b.new_context().new_page()

    bad = []
    page.on("response", lambda r: bad.append((r.status, r.url)) if r.status >= 400 else None)

    page.goto(URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(2000)

    print(f"bad responses: {len(bad)}")
    for s, u in bad: print(f"  {s} {u}")
    b.close()
