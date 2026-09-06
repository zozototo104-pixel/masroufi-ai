# Manual CI verification trigger

Rerun after fixing tests and receipt split implementation.

Verify current HEAD:
- receipt record uses one accountBalances snapshot only; no getBalance bootstrap/full-ledger scan during import record
- if account balance snapshot is missing, receipt split fails closed instead of converting PalPay balance to debt
- receipt split order: selected liquid account, other liquid account, debt only remainder
- atomic batch still validates balances with skipLedgerBalanceCheck false
- salary-cycle debt summary exposes current remaining debt for cycle creditors and later repayments
- delete_recent_transactions remains bounded and atomic for last 3 expenses / latest debt payment

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T09:03:00+03:00
