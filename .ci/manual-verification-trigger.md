# Manual CI verification trigger

Rerun after updating VAULT-04 expectations for debt-payment liquidity.

Expected behavior:
- Debt repayment is not counted as a new expense.
- Debt repayment is counted as liquidity leaving the salary cycle.
- Vault-eligible surplus = true income - true expenses - debtPaid.
- Dashboard spendable = cycle inflow - expense - debtPaid - vaultContribution.
- Close-month vault commands route to recalculate_salary_cycle, not pay_debt.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T10:50:00+03:00
