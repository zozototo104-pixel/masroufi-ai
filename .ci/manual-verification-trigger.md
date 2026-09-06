# Manual CI verification trigger

Verify credit/debt purchase fixes.

User issue:
- User said: "سجلي دين 10 شيكل مشتريات من أبو العبد".
- System recorded a debt but also subtracted from cash/liquid balance.
- Then "احذف آخر عملية دين" said there are no debt operations, even with amount/date details.

Fixes:
- add_transaction now detects Arabic credit purchase intent from full text: دين/بالدين/آجل/على الحساب + شراء/مشتريات/سجلي, excluding repayment/borrowing.
- forcedCreditPurchaseIntent forces account=debt before the cash default is applied.
- CREDIT_PURCHASE skips cash/PalPay preflight and is persisted as transactionType=CREDIT_PURCHASE.
- credit purchase accepts creditor/seller/vendor/person aliases as merchant/creditor.
- delete_recent_transactions treats generic debt delete as credit_purchase unless repayment words are explicit.
- credit_purchase deletion also catches previously misrecorded cash expense debt purchases by text.
- Balance invariant: credit purchase increases debt only and does not reduce cash/PalPay/total.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T13:01:00+03:00
