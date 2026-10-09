"""Sign in to a job site in a real browser window on the Mac, then save the session for the phone.
You type your password/OTP yourself; only the resulting cookies are saved (never the password).
Usage: login.py linkedin|naukri  -> writes data/sessions/<site>.json and <site>.ua next to this repo."""
import json, pathlib, sys, time
from playwright.sync_api import sync_playwright

SITES = {
    "linkedin": ("https://www.linkedin.com/login", lambda u: "/feed" in u or "/in/" in u or "/jobs" in u),
    "naukri": ("https://www.naukri.com/nlogin/login", lambda u: "mnjuser" in u),
}
site = sys.argv[1]
start, done = SITES[site]
out = pathlib.Path(__file__).resolve().parent.parent / "data" / "sessions"
out.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    # A persistent profile: if this window is closed or times out, the next run is already signed in.
    ctx = p.chromium.launch_persistent_context(str(out / f"{site}-profile"), headless=False,
        args=["--disable-blink-features=AutomationControlled"], viewport={"width": 1280, "height": 860},
        locale="en-IN", timezone_id="Asia/Kolkata")
    page = ctx.pages[0] if ctx.pages else ctx.new_page()
    page.goto(start)
    print(f"Sign in to {site} in the browser window (up to 30 minutes)...", flush=True)
    deadline = time.time() + 1800
    while time.time() < deadline:
        urls = [pg.url for pg in ctx.pages]     # any tab counts
        if any(done(u) for u in urls):
            page.wait_for_timeout(4000)         # let the site finish setting cookies
            ctx.storage_state(path=str(out / f"{site}.json"))
            (out / f"{site}.ua").write_text(page.evaluate("navigator.userAgent"))
            print(f"SAVED {site} session", flush=True)
            break
        page.wait_for_timeout(2000)             # (not time.sleep: Playwright only sees navigation while it runs)
    else:
        print("TIMEOUT: not signed in", flush=True)
    ctx.close()
