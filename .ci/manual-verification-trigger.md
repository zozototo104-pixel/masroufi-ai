# Manual CI verification trigger

Verify salary-cycle navigation/details/delete after confirming atomicDeleteTransactions exists on current HEAD.

Scope:
- Vault cycle picker current + previous cycles
- GET /api/salary-cycles/:cycleId details
- DELETE /api/salary-cycles/:cycleId/transactions bounded delete
- atomicDeleteTransactions import and implementation
- tests, TypeScript, build, runtime smoke

Timestamp: 2026-09-05T21:14:00+03:00
