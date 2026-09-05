# Manual CI verification trigger

Verify PalPay income cloud-save fix.

User confirmed:
- salary/income cash saves successfully
- income on PalPay still reports cloud save problem

Fix:
- removed index-sensitive preflight duplicate query for all income writes
- generic income now uses users/{uid}/incomeGuards guard document inside atomicAddTransaction
- salary income still uses users/{uid}/salaryIncomeGuards by salary cycle
- duplicateConfirmed can bypass existing income guard intentionally
- wipe deletes/verifies both income guard collections

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T15:18:00+03:00
