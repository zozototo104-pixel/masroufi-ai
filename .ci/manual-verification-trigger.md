# Manual CI verification trigger

Verify locked Savings Vault semantics.

User-reported issue:
- after completing July and moving the remainder to the vault, cash/PalPay still showed July leftovers as available in August
- income for the next historical cycle looked like zero because vault semantics were only metadata, not a locked account

Fixes:
- balance core now has a separate vault balance excluded from available total
- vault lock transfers cash/PalPay -> vault reduce liquidity and increase locked vault
- opening vault transfers vault -> cash/PalPay and is not income
- closing a salary cycle creates deterministic idempotent VAULT_LOCK transactions by cash/PalPay source
- historical cycle recalculation does not auto-lock during data entry unless the user explicitly closes/locks the cycle or it was previously locked
- Vault UI has explicit إقفال الدورة وترحيل للخزنة and فتح الخزنة للحاجة actions
- manual vault transfer updates savingsVault meta atomically

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T22:17:00+03:00
