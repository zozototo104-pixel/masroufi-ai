# Manual CI verification trigger

Final verification after multi-currency Savings Vault carryover patch.

No further code changes after this trigger unless CI reports a failure.

Scope:
- tools.ts restored and stable
- src/lib/vaultCurrency.ts added
- add_savings_vault_adjustment supports amount/currency and amounts[]
- original ILS/USD/EUR amounts retained in currencyDelta/balanceByCurrency
- ILS equivalent is only a summary field
- UI shows per-currency vault balances
- VAULT-CURRENCY-* regression tests added

Timestamp: 2026-09-05T10:42:00+03:00
