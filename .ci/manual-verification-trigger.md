# Manual CI verification trigger

Verify salary-cycle cash/PalPay trace diagnostics.

User issue:
- The problem is not only actual balance total. Actual balance = cash + PalPay.
- User expects liquid/cycle available around 2916 and PalPay 750, so expected cash = 2166.
- UI shows cash 2123, a 43 ₪ missing-cash difference.
- Need to distinguish a real cash expense/transfer/debt payment/vault lock from a stale accountBalances snapshot.

Fix:
- getSalaryCycleDetails now returns cashTrace computed from txBalanceDelta for the selected salary cycle only.
- cashTrace reports cashIn, cashOut, netCashDelta, palPayIn, palPayOut, netPalPayDelta, netLiquidDelta, debtDelta, vaultDelta, ignoredDebtPurchases.
- cashTrace rows show per-transaction cashDelta and palPayDelta plus reason.
- CREDIT_PURCHASE/debt purchases are shown as expenses with Cash 0 impact, so they do not explain missing cash.
- UI shows "تتبع النقدي وPalPay لهذه الدورة" inside Savings Vault details.
- This is bounded by the existing selected salary-cycle query and does not add a full ledger scan.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T16:29:00+03:00
