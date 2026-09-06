# Manual CI verification trigger

Verify recent debt-payment deletion catches misrouted creditor-overpayment rows.

User issue:
- Assistant said it searched and did not find the latest debt payment.
- The wrong transaction was displayed as "فائض سداد (دائن)", so it may not be transactionType=DEBT_PAYMENT.

Fix:
- matchesRecentDeleteKind(kind=debt_payment) now matches:
  - transactionType DEBT_PAYMENT / DEBT_REPAYMENT / PAY_DEBT
  - transactionType CREDITOR_OVERPAYMENT / DEBT_OVERPAYMENT
  - transfer to debt
  - income on account=debt
  - Arabic text containing فائض سداد / دائن when tied to debt
- delete_recent_transactions remains bounded by createdAt desc + limit(searchLimit) and atomicDeleteTransactions.

Expected behavior after deploy:
- "احذف آخر عملية سداد دين" can delete the misrouted فائض سداد دائن row and reverse its balance effect.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T10:58:00+03:00
