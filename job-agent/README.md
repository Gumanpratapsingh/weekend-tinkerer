# Job agent

An always-on job hunter on the phone. It finds jobs (Naukri, LinkedIn Easy Apply, Greenhouse/Lever/Ashby company
boards, free remote feeds), scores the fit with an LLM, tailors the resume to each description using only true facts,
applies through a real browser, watches the mailbox for recruiter replies, and asks the owner on WhatsApp whenever it
meets a question it can't answer. Every answer is remembered in SQLite. Live dashboard: hub `/jobs`.

```
Termux (Node 24)                                 Debian proot (Xvfb + headed Chromium)
src/agent.mjs  :8083  schedules, WhatsApp webhook  ──►  browser/worker.mjs :8084
  discover → score → tailor → apply                     naukri / linkedin / ats appliers, PDF rendering
  mail (IMAP) → classify → answer → draft → ok?    ◄──  /internal/resolve: answers from the memory
data/agent.db  jobs · questions · asks · emails · drafts · events
```

- **Honest resume:** `src/tailor.mjs` lets the LLM reorder and reword, then rejects any line that adds a skill,
  number or scale claim its source fact doesn't support.
- **Not spammy:** per-site hours, random gaps and daily caps (`profile/config.json` → `pacing`, `daily_caps`),
  at most 3 applications per company a day, one at a time. CAPTCHAs are never bypassed: the job goes to "apply yourself".
- **Safe start:** dry-run by default (forms filled, never submitted) until "go live".
- **Private data** (`profile/master.json`, `profile/private.json`, `data/`) is gitignored; see `profile/README.md`.

Deploy: `./deploy.sh` (copies to `~/jobagent` on the phone, restarts both processes). Boot: `~/start.sh` runs `scripts/run.sh start`.
