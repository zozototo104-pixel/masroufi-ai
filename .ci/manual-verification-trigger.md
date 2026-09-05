# Manual CI verification trigger

Verify typed salary cycle navigation UI and bounded delete implementation.

Current changes:
- current + 12 previous salary cycles shown in Vault picker even before cycle docs exist
- selected cycle details load from /api/salary-cycles/:cycleId
- bounded delete uses /api/salary-cycles/:cycleId/transactions with explicit confirmation
- backend has getSalaryCycleDetails and deleteSalaryCycleTransactions
- atomicDeleteTransactions added for balance-aware bulk cycle delete

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T21:06:00+03:00
