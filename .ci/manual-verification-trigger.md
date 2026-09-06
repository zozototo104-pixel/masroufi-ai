# Manual CI verification trigger

Rerun after updating spendable-card regression test wording.

Expected behavior:
- Credit purchase is included in expenses but does not reduce cash/PalPay.
- Cycle spendable text and logic avoid same-cycle debt-payment double-counting.
- Manual "إصلاح الرصيد الفعلي" button rebuilds accountBalances snapshot only on explicit user request.
- Account balance repair is manual because it performs a full ledger read; normal reads remain O(1) via accountBalances snapshot.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T16:22:00+03:00
