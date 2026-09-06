# Manual CI verification trigger

Verify active salary cycle totals update immediately after transaction changes.

User request:
- Expense/income cycle cards should update as soon as a new expense/income is added.
- User should not need to open cycle details, switch cycle, and come back to see updated values.

Fix:
- App keeps selectedVaultCycleIdRef for the active salary cycle.
- masrofi:refresh with transaction/financial/vault scopes fetches vault meta and reloads only /api/salary-cycles/{activeCycleId}?limit=500.
- Dashboard income/expense/spendable cards are backed by selectedVaultCycleDetails.summary when a cycle is active.
- This is bounded to one salary cycle and avoids a full ledger reload for simple transaction changes.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T07:46:00+03:00
