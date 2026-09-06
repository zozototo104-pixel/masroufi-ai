# Manual CI verification trigger

Final verification for debt purchase cash invariant and debt delete routing.

User issue:
- "سجلي دين 10 شيكل مشتريات من أبو العبد" was recorded as debt but also subtracted from cash/liquid balance.
- "احذف آخر عملية دين" did not find the operation.

Expected behavior:
- Arabic text containing دين/بالدين/آجل/على الحساب + سجلي/مشتريات/شراء forces account=debt before the default cash account is applied.
- Credit purchase persists as type=expense, account=debt, transactionType=CREDIT_PURCHASE, creditor=merchant.
- Credit purchase only increases debt; it never subtracts cash or PalPay and does not change liquid total.
- "احذف آخر عملية سداد دين" routes to debt_payment.
- "احذف آخر عملية دين" without سداد/تسديد routes to credit_purchase.
- Recent credit_purchase delete catches both proper CREDIT_PURCHASE rows and old misrecorded cash expense rows whose text contains debt purchase words.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T13:07:00+03:00
