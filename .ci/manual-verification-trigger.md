# Manual CI verification trigger

Verify fixes for receipt import split, recent deletion, and salary-cycle debt reporting.

User-reported issue:
- Imported expenses selected as cash consumed cash, then put the remainder on debt even when PalPay had balance.
- Debt payment reduced global debt, but a later question about debt in salary cycle 8 did not acknowledge the partial payment.
- User needs to delete last 3 expense rows and the latest debt-payment row without re-importing everything.

Fixes:
- Receipt record now uses server-side getBalance before splitting, not stale client balances.
- If verified balances are partial/unsafe, receipt split fails closed instead of converting to debt.
- Receipt split order is selected liquid account first, other liquid account second, debt only for the remainder.
- Salary-cycle summaries now include debtCreated/debtPaid/netDebtChange.
- Salary-cycle debt questions attach current remaining debt for creditors in that cycle, including later repayments.
- payDebt returns affectedCycleIds for targeted refresh.
- delete_recent_transactions tool remains bounded, atomic, and registered for voice/text tools.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T08:48:00+03:00
