# Manual CI verification trigger

Verify debt/credit-purchase recognition after production issue.

User issue:
- "سجلي دين 10 شيكل مشتريات من أبو العبد" appeared inside expenses but the assistant said there are no debts.
- It also reduced cash/liquid balance instead of creating a debt-only credit purchase.
- The salary-cycle details did not clearly show the row as debt/credit purchase.

Fixes:
- add_transaction includes structured account/paymentMethod/transactionType fields in intent detection.
- structuredCreditPurchaseIntent forces account=debt when Gemini sends CREDIT_PURCHASE, paymentMethod=debt, account=debt, or creditor for an expense.
- future credit purchases persist as account=debt and transactionType=CREDIT_PURCHASE, increasing debt and not reducing cash/PalPay.
- repair_misrecorded_credit_purchase can find a bad cash/PalPay expense by explicit amount+creditor even if the stored row lost the word دين.
- server fallback routes complaints like "مش معترف أنها دين" / "حاططها مصروفات" / "خصمت من النقدي" to repair_misrecorded_credit_purchase.
- salary cycle details now expose debtPurchases and bucket credit purchases under "دين / مشتريات آجلة".
- UI labels credit-purchase rows as "دين/آجل" and shows a separate "مشتريات دين داخل الدورة" section.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T14:28:00+03:00
