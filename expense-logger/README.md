# Expense logger

Log spending by voice or text; the phone keeps the ledger. Code: [server/modules/expenses.mjs](../server/modules/expenses.mjs), page: `/expenses`.

- **Log:** Siri shortcut "Log expense" (asks amount and note), or send `250 swiggy dinner` to your ntfy `<topic>-exp` topic.
- **Commands:** `today`, `week`, `month`, `undo`, `budget food 5000`, `budgets`.
- **Categories:** keyword rules first (swiggy → Food, uber → Transport), an LLM only for unclear notes.
- **Automatic:** monthly summary on the 1st at 9 AM; budget warnings at 80% and 100%.
- **Hub:** month view, by-category bars against budgets, add/delete, CSV export.

## Automatic from bank SMS

Every debit SMS from your bank becomes an expense without you doing anything. Code: [server/modules/banksms.mjs](../server/modules/banksms.mjs).

- **How:** an iPhone automation ("When I get a message containing `debited`") runs the **Log bank SMS** shortcut,
  which POSTs the text to `/api/expenses/sms` with a secret `X-Sms-Token` header.
- **Parsing:** amount (`Rs.450`, `INR 1,299.00`, `₹250`, SBI's `debited by 250.0`) and merchant (`To ZOMATO`,
  `VPA swiggy@icici` → swiggy, `UPI/P2M/…/ZOMATO`, `; AMAZON PAY credited`, `at AMAZON`); then the usual categories.
- **Ignored:** credits, refunds, OTPs, "will be debited" autopay reminders, declined/failed payments, collect requests.
- **Duplicates:** the same SMS twice, or the same amount + merchant within 3 minutes, is logged once.
- **Privacy:** only amount and merchant are kept. The SMS is never stored or logged (it can hold account digits).
  The token lives in `~/tinker/sms-token` on the phone (mode 600) and inside the shortcut; it is never in this repo.

**Set up on the iPhone (once):**
1. AirDrop *Log bank SMS.shortcut* to the iPhone → Add Shortcut.
2. Shortcuts → Automation → **+** → **Message** → *Message Contains* `debited` → **Run Immediately** → Next.
3. Add action **Run Shortcut** → *Log bank SMS*, and set its input to **Shortcut Input** (the message).
4. Repeat steps 2–3 for `spent` (card alerts) and `Sent Rs` (HDFC/Kotak UPI). Overlaps are de-duplicated.
