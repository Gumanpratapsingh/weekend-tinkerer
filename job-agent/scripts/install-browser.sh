#!/data/data/com.termux/files/usr/bin/sh
# One-time: Debian userland (proot) with its own Node, Xvfb and Playwright Chromium for the job agent.
set -e
proot-distro login --isolated debian -- /usr/bin/env -i HOME=/root PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin bash -lc "
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg xvfb xauth fonts-noto-core fonts-liberation >/dev/null
  [ -x /usr/bin/node ] || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null; apt-get install -y -qq nodejs >/dev/null; }
  node -v
  mkdir -p /opt/pw && cd /opt/pw && { [ -f package.json ] || npm init -y >/dev/null; }
  npm i -s playwright@1.48.2
  apt-get install -y -qq chromium fonts-unifont >/dev/null; npx playwright install chromium
  cat > /opt/pw/smoke.js <<JS
const { chromium } = require(\"/opt/pw/node_modules/playwright\");
(async () => {
  const b = await chromium.launch({ headless: false, args: [\"--no-sandbox\"] });
  const p = await b.newPage();
  await p.goto(\"https://example.com\");
  console.log(\"BROWSER_OK\", await p.title());
  await b.close();
})().catch((e) => { console.error(\"BROWSER_FAIL\", e.message); process.exit(1); });
JS
  xvfb-run -a node /opt/pw/smoke.js
"
