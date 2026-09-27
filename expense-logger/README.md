# Expense logger

Log spending by voice or text; the phone keeps the ledger. Code: [server/modules/expenses.mjs](../server/modules/expenses.mjs), page: `/expenses`.

- **Log:** Siri shortcut "Log expense" (asks amount and note), or send `250 swiggy dinner` to your ntfy `<topic>-exp` topic.
- **Commands:** `today`, `week`, `month`, `undo`, `budget food 5000`, `budgets`.
- **Categories:** keyword rules first (swiggy → Food, uber → Transport), an LLM only for unclear notes.
- **Automatic:** monthly summary on the 1st at 9 AM; budget warnings at 80% and 100%.
- **Hub:** month view, by-category bars against budgets, add/delete, CSV export.
