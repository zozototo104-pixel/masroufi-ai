# Manual CI verification trigger

Verify locked Savings Vault account integration.

Fixes under verification:
- Savings Vault is now a locked ledger account (`vault`) excluded from available liquidity total.
- Closing a salary cycle explicitly creates deterministic VAULT_LOCK transfers from cash/PalPay to vault.
- Existing/previously locked cycles are idempotently adjusted instead of duplicated.
- Historical closed cycles do not auto-lock while the user is still entering data unless lockVault/closeCycle is explicit.
- Opening the vault creates a VAULT_RELEASE transfer from vault to cash/PalPay and is not income.
- Manual old vault carryover updates both savingsVault meta and accountBalances.vault.
- Account balance repair preserves authoritative savingsVault meta balance.
- UI exposes: إقفال الدورة وترحيل للخزنة and فتح الخزنة للحاجة.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T22:26:00+03:00
