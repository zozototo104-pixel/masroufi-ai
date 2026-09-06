# Manual CI verification trigger

Verify credit purchase recording path.

User issue:
- Voice assistant collected all details for "اشتريت دين من عند فلان" but then said there is a system problem and would not save.

Fixes:
- add_transaction accepts creditor/seller/vendor/person aliases as merchant for credit purchases.
- credit purchase is identified as type=expense account=debt/paymentMethod=debt.
- credit purchases skip the cash/PalPay preflight balance/risk query that can fail with PARTIAL_STATE_UNSAFE or secondary query errors.
- Firestore write still goes through atomicAddTransaction and persists transactionType=CREDIT_PURCHASE with creditor/creditorKey.
- Assistant prompt clarifies that credit purchase uses add_transaction, not pay_debt.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T12:58:00+03:00
