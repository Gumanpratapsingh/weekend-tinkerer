# Presence: auto arm and disarm

Room alerts turn on when you leave home and off when you return, using iPhone location automations. No code on the phone: Android blocks apps from scanning the Wi-Fi network, and the iPhone already knows where you are.

In the iPhone **Shortcuts** app → **Automation** → **+**:

1. **Leave** → your home address → **Run Immediately** → action *Get Contents of URL*:
   `https://ntfy.sh/<topic>-ctl/publish?message=arm`
2. **Arrive** → your home address → **Run Immediately** → the same URL with `message=disarm`.

The room watcher answers each change with a push, so you can see it worked.
