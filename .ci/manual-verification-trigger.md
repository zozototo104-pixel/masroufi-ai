# Manual CI verification trigger

Verify dashboard totals are scoped to the active salary cycle.

User-reported issue:
- Spendable balance subtracted July vault from August global balance.
- August income stayed 0 even after adding 4100, including PalPay income on Aug 1.

Root cause:
- Dashboard cards computed from the visible transactions list, but /api/transactions is intentionally bounded for Firestore efficiency and may not contain the selected historical salary cycle.
- Spendable card used cash + PalPay - global vaultBalance, mixing a prior cycle vault with the active cycle.

Fix:
- Dashboard cards now use selectedVaultCycleDetails.summary when a cycle is selected in the Vault modal.
- Otherwise they summarize only the current 27→26 salary cycle.
- Spendable balance is active cycle inflow - active cycle expense - vault contribution for the same cycle only.
- It no longer subtracts the entire global vault balance.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T04:39:00+03:00
