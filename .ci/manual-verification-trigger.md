# Manual CI verification trigger

Verify repair for debt purchases that were deducted from cash/PalPay.

User issue:
- User said: "سجلي دين 10 شيكل مشتريات من أبو العبد".
- The system recorded it as debt-related but also deducted 10 ₪ from cash/liquid balance.
- User asked who returns the missing cash.

Expected behavior:
- Normal future credit purchases are forced to account=debt from Arabic intent before cash default.
- Existing bad row can be repaired with repair_misrecorded_credit_purchase.
- Repair updates the same transaction to account=debt/paymentMethod=debt/transactionType=CREDIT_PURCHASE.
- Repair does not add fake income and does not create a reverse transaction.
- Atomic update replacement delta restores cash/PalPay and increases/keeps debt correctly.
- Server fallback/prompt routes phrases like "مين يرجع النقص" or "الدين خصم من النقدي" to repair_misrecorded_credit_purchase.
- Generic "احذف آخر عملية دين" still routes to credit_purchase, while "احذف آخر سداد دين" routes to debt_payment.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T13:20:00+03:00
