# Manual CI verification trigger

Verify legacy CREDIT_PURCHASE debt recognition and direct visible-row repair.

User issue:
- Salary-cycle details display a 10 ₪ item as دين/آجل.
- The voice expert still says there are no debts.
- This means one path sees transactionType=CREDIT_PURCHASE, while balance/debt summary may only count account=debt.

Fixes:
- src/lib/accountBalance treats type=expense + transactionType=CREDIT_PURCHASE as account=debt even if a legacy row has account=cash.
- src/lib/balanceCalc does the same for calculateBalances and creditor debt breakdown.
- calculateCreditorRemaining now recognizes legacy CREDIT_PURCHASE rows stored on cash.
- repair_misrecorded_credit_purchase supports transactionId/id to convert the selected visible expense row directly into account=debt/paymentMethod=debt/CREDIT_PURCHASE.
- API endpoint: POST /api/transactions/repair-credit-purchase.
- Vault salary-cycle UI shows a per-row "ثبّت كدين" button when a CREDIT_PURCHASE is not stored on account=debt.
- This avoids relying on Gemini/voice recognition when the row is visible in the UI.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T14:42:00+03:00
