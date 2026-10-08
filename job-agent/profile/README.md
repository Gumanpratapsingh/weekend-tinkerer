# profile/

| File | In git | What |
|---|---|---|
| `config.json` | yes | Search queries, title filters, locations, score threshold, daily caps, company boards |
| `master.json` | **no** | Every true fact on the resume (roles, bullets, projects, skills). Tailored resumes are built only from this. Each bullet has `id`, `text` and `supports` (terms a rewrite may use). |
| `private.json` | **no** | `{"mailbox": "...", "known_answers": {"question": "answer"}}`, answers seeded into the question memory at start |

`deploy.sh` copies the whole folder, so the private files reach the phone without ever being committed.
