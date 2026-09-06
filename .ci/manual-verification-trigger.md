# Manual CI verification trigger

Verify final fixes for receipt import split, safe recent deletion, and salary-cycle debt questions.

Critical user issues:
- receipt import must use cash first, then PalPay, then debt only for the remainder
- the app must not trust stale client balances when splitting imported expenses
- user needs a bounded voice tool to delete latest expense rows and latest debt payment
- asking about debt in salary cycle 8 must recognize repayments made after the cycle
- debt summary fallback must not introduce a new composite-index failure

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T08:52:00+03:00
