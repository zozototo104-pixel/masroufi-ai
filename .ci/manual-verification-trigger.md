# Manual CI verification trigger

Final verification for locked Savings Vault account behavior.

Must verify current HEAD after the latest fixes:
- vault is a locked account in calculateBalances and account balance deltas
- available total excludes vault
- cycle close writes deterministic VAULT_LOCK transfers and updates accountBalances
- manual vault carryover updates savingsVault meta and accountBalances.vault
- manual vault release updates both accountBalances and savingsVault meta
- repairAccountBalanceSnapshot preserves authoritative savingsVault meta balance
- historical cycles do not auto-lock during data entry without explicit lockVault/closeCycle
- UI has explicit close-cycle and open-vault controls

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T22:34:00+03:00
