# Manual CI verification trigger

Verify fixes for receipt import split, safe rollback, and salary-cycle debt reporting.

User issue:
- Receipt import used cash until exhausted, then recorded the rest as debt even when PalPay had balance.
- User needs to delete the last 3 expense additions and the last debt-payment operation without re-importing from scratch.
- Debt question for salary cycle 8 did not acknowledge a repayment made today after the cycle.

Fixes:
- /api/scan-receipt/record reads server-side accountBalances instead of trusting stale client currentBalances.
- Receipt expenses split selected liquid account first, then the other liquid account, then debt only for the remainder.
- Receipt commit uses atomic balance validation (skipLedgerBalanceCheck=false).
- Imported debt uses canonical normalizeCreditorKey.
- Receipt record returns affectedCycleIds and the app refreshes those cycles.
- New delete_recent_transactions tool deletes last N expenses or latest debt payment via bounded createdAt query and atomic delete.
- query_transactions adds debtSummary for salary-cycle debt questions by reading only affected creditors, so post-cycle repayments are recognized.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T08:45:00+03:00
