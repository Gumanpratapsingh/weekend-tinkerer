# weekend-tinkerer

Small, stubbornly useful tools built on weekends and self-hosted on a **Samsung Galaxy S20 FE whose audio
chip and camera died**. The phone runs Termux (no root), nginx and a Cloudflare Tunnel from a cupboard, on a
power bank. Everything here is served from it.

One private web app, the **Tinker hub**, fronts all the tools. Each tool is a route on the same static site:

| Route | Tool | What it does |
|---|---|---|
| `/expenses` | [Expense logger](expense-logger/) | Log by Siri or a text ("250 swiggy dinner"); auto categories; budgets; monthly summary; CSV |
| `/interview` | [Interview coach](interview-coach/) | A question every morning, graded by an LLM, weak topics repeat sooner, Sunday recap |
| `/linkedin` | [LinkedIn drafts](linkedin-drafts/) | Friday draft from the week's commits; you approve and post it yourself |
| `/tamil` | [Tamil phrase](tamil-phrase/) | A practical Chennai Tamil phrase every morning, themed weeks, Sunday quiz |
| `/room` | Room watcher view | Lights on/off log from the phone's light sensor; arm/disarm alerts |
| — | [Presence](presence/) | iPhone location automations arm/disarm the room alerts |

## How it fits together

```
browser ──► tinker Worker (Cloudflare) ──► tunnel ──► phone: nginx
                                                        ├─ /hub/*      hub/ (static single page)
                                                        └─ /hub/api/*  server/ (Node, 127.0.0.1:8082)
iPhone Siri / ntfy app ──► ntfy topics ──────────────────► server/ listens and replies with pushes
```

- **server/**: one small Node process (no dependencies) with a module per tool; schedules run in IST.
- **hub/**: vanilla HTML/CSS/JS. The path picks the page; data is always inserted as text, never HTML.
- **worker/tinker.js**: maps `tinker.<you>.workers.dev/<path>` to `<origin>/hub/<path>` only. The origin host
  is a placeholder here; `render-worker.sh` fills it in when copying the code to deploy.

## Security

- Owner-only: a single password, stored on the phone as a scrypt hash (`set-password.sh`, hidden prompt).
- Session cookie: random 256-bit token, `HttpOnly; Secure; SameSite=Strict`, 30 days, kept server-side.
- 5 failed logins lock that visitor out for 15 minutes, and every failure sends a push alert.
- State-changing requests need a custom `X-Hub` header (blocks cross-site form posts).
- Strict Content-Security-Policy on the hub; nginx rate limits; the server listens on localhost only.
- Private data (expenses, answers, room log) stays on the phone and is never committed.
- LLM calls (Groq) only get what a feature needs; private repo names are replaced before summaries.

## Deploy

```bash
./deploy.sh                 # copy hub/ + server/ to the phone and restart the server
./set-password.sh           # set or change the hub password (hidden prompt)
worker/render-worker.sh     # copy the Worker code, origin filled in, for the Cloudflare editor
```

Needs on the phone: Termux, Node.js LTS, the Groq key at `~/.groq_key`, the ntfy topic at `~/room/ntfy-topic`,
and optionally a read-only GitHub token at `~/.github_token` (LinkedIn drafts).
The phone's base setup (nginx, tunnel, monitor) lives in a separate private repo.
