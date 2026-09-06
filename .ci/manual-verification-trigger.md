# Manual CI verification trigger

Verify direct repair path for misrouted vault-close creditor surplus.

User issue:
- The voice assistant refuses to recognize/delete the bad row because it is not a normal DEBT_PAYMENT.
- The row appears in the UI as "فائض سداد (دائن)" after the user attempted to close the salary cycle to Savings Vault.

Fix:
- Backend tool repair_misrouted_vault_close searches only the latest bounded transactions by createdAt desc + limit.
- It detects creditor surplus / overpayment / debt overpayment / income on debt / transfer to debt patterns.
- It uses atomicDeleteTransactions, not a fake reverse transaction.
- It recalculates only the affected salary cycle.
- API endpoint: POST /api/savings-vault/repair-misrouted-close.
- Vault UI button: "تصحيح فائض دائن خاطئ".
- The repair can fallback if the visible amount hint does not exactly match the stored bad row.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T11:06:00+03:00
