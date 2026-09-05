# Manual CI verification trigger

Rerun after updating legacy tests for the PalPay income guard design.

Design now:
- all income writes avoid index-sensitive preflight range queries
- generic cash/PalPay income uses incomeGuards fixed docs
- salary income uses salaryIncomeGuards fixed docs by salary cycle
- partial-state tests still require bounded expense safety reads to fail closed

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T15:32:00+03:00
