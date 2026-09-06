# Manual CI verification trigger

Verify immediate salary-cycle card refresh after transaction writes.

User issue:
- Expense/income values only updated after page reload and re-entering the cycle.

Root cause:
- masrofi:refresh did not include the affected salary cycle id.
- App refreshed only the stale selected cycle or global data.

Fix:
- addTransaction returns affectedCycleId/affectedCycleIds based on the transaction date and 27→26 salary cycle.
- Live tool refresh messages include affectedCycleIds.
- useGeminiLive forwards affectedCycleIds to the app refresh event.
- Text chat computes affectedCycleIds from committedTransactions.
- App refresh reloads /api/salary-cycles/{affectedCycleId}?limit=500 and updates selectedVaultCycleDetails immediately.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T08:12:00+03:00
