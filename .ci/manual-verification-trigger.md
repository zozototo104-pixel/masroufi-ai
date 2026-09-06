# Manual CI verification trigger

Verify same-cycle debt repayment does not reduce Savings Vault surplus twice.

User case from production:
- Salary cycle 08-2026 income: 4350 ₪
- Expenses: 3905 ₪
- Expected remaining/vault surplus: 445 ₪
- Assistant locked only 24 ₪ because it calculated 4350 - 3905 - 421 debtPaid = 24.
- That was wrong because the 421 ₪ debt was created by purchases already included in the same cycle expenses, so paying it should not be subtracted again.

Fix:
- summarizeSalaryCycleTransactions now tracks same-cycle credit purchases by creditor.
- debtPaymentLiquidityOutflow = debtPaid that exceeds same-cycle credit purchases for that creditor.
- Vault surplus = income - expense - debtPaymentLiquidityOutflow.
- Same-cycle credit purchase + same-cycle payment: outflow 0, no double count.
- Older debt repayment with no same-cycle credit purchase: outflow equals repayment and reduces vault surplus.
- Dashboard spendable uses debtPaymentLiquidityOutflow, not total debtPaid.
- salaryCycles docs persist debtPaymentLiquidityOutflow and include it in sourceVersion.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T11:52:00+03:00
