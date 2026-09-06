# Manual CI verification trigger

Verify actual balance vs salary-cycle spendable and credit-purchase accounting.

User issue:
- Salary cycle: income 4100, expenses 1184 including 10 ₪ credit purchase.
- Correct liquid cycle spendable = 4100 - (1184 - 10) = 2926 ₪.
- UI showed available for cycle 2926 ₪ but actual balance 2873 ₪.
- The 53 ₪ difference indicates accountBalances snapshot/general balance diverged from cycle-derived liquidity after earlier bad credit-purchase/debt operations.

Expected behavior:
- Credit purchase is included in expenses but does not reduce cash/PalPay.
- Actual balance card explains it comes from accountBalances cash + PalPay, while cycle available comes from the selected salary cycle.
- Manual button "إصلاح الرصيد الفعلي" calls POST /api/account-balance/repair.
- Repair rebuilds accountBalances from ledger once; it is manual, not automatic, to avoid burning Firestore reads.
- Legacy CREDIT_PURCHASE rows stored with account=cash still count as debt in accountBalance/balanceCalc.
- Per-row "ثبّت كدين" remains available only when the visible row itself needs conversion.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T16:18:00+03:00
