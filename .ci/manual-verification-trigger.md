# Manual CI verification trigger

Final run after PalPay income cloud-save fix.

Current fix:
- all income writes skip index-sensitive preflight range query
- salary income uses salaryIncomeGuards by 27→26 salary cycle
- generic income including PalPay uses incomeGuards by date/account/amount/category/subcategory
- atomicAddTransaction commits the transaction and guard together
- wipe deletes/verifies salaryIncomeGuards and incomeGuards

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T15:24:00+03:00
