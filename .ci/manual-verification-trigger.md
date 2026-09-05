# Manual CI verification trigger

Verify the salary-cycle details fix after the user hit Firestore index error.

Observed production error:
- FAILED_PRECONDITION: The query requires an index
- triggered by عرض البنود in Savings Vault salary cycle details

Fixes:
- added firestore.indexes.json for proper composite indexes
- readTransactionsForSalaryCycle now has an index-free bounded fallback
- fallback queries only the selected 27→26 date range, then filters userId server-side
- cycle detail dates render left-to-right in RTL UI
- picker uses من/إلى instead of arrow-only formatting

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T21:03:00+03:00
