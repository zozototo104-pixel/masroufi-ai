# Manual CI verification trigger

Rerun after fixing TypeScript narrowing in delete_recent_transactions.

Verify:
- historical pay_debt settlement routes to the selected salary cycle
- recent delete TypeScript narrowing passes
- tests/build/runtime remain green

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T10:18:00+03:00
