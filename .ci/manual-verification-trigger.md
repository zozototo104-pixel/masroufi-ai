# Manual CI verification trigger

Verification after safe multi-currency Savings Vault carryover patch.

Scope:
- restored src/server/tools.ts from last known good before continuing
- added src/lib/vaultCurrency.ts helper
- add_savings_vault_adjustment accepts single currency or amounts[] entries
- preserves original ILS/USD/EUR balances in balanceByCurrency
- stores ILS equivalent for summary display only
- fails safely if FX rate is unavailable and no user-provided exchange rate exists
- UI displays per-currency vault balances
- regression tests VAULT-CURRENCY-* added

Timestamp: 2026-09-05T10:36:00+03:00
