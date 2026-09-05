# Manual CI verification trigger

Verify salary cycle navigation and bounded delete UI.

User need:
- navigate between salary cycles/months
- view income and expense line items for a selected 27→26 cycle
- see vault contribution for that cycle
- delete one salary cycle's transactions only, after explicit confirmation

Changes:
- getSalaryCycleDetails backend tool/API
- deleteSalaryCycleTransactions backend tool/API
- atomicDeleteTransactions balance-aware helper
- Vault UI cycle picker with current + 12 previous local cycles
- cycle details panel for income/expenses/vault contribution
- bounded selected-cycle delete action

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T21:02:00+03:00
