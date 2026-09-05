# Manual CI verification trigger

Integrated verification after user-reported blockers.

Fixes:
- salary income on 27/6 no longer depends on index-sensitive preflight range query
- salary duplicate protection uses users/{uid}/salaryIncomeGuards guard doc inside atomicAddTransaction
- atomicAddTransaction reads/writes uniqueness guard in the same Firestore transaction
- wipe deletes and verifies salaryIncomeGuards
- Live tool logs safe outcome fields: success/reason/retryable/transactionCommitted without financial details
- full financial tool response logging is redacted
- live quota classifier and echo gate remain intact

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T14:58:00+03:00
