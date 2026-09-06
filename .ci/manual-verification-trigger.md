# Manual CI verification trigger

Rerun after fixing the refresh-scope regression test string quoting.

Verify:
- active salary cycle totals refresh immediately after transaction changes
- selected cycle details reload via /api/salary-cycles/{cycleId}?limit=500
- dashboard cards use selected cycle summary when available
- no global vault subtraction from active cycle spendable amount

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T07:49:00+03:00
