# Manual CI verification trigger

Verify salary-cycle details after fixing fallback response semantics.

Observed production issue:
- Savings Vault عرض البنود still showed FAILED_PRECONDITION: query requires an index
- Render had deployed the fallback commit

Root cause:
- readTransactionsForSalaryCycle fallback returned data, but getSalaryCycleDetails marked boundedFallback as partial/error and surfaced the original index message

Fix:
- getSalaryCycleDetails now treats bounded fallback as success when the bounded date-range fallback did not hit the limit
- reason is only set for true partial/limit cases
- fallbackUsed is returned as metadata, not as user-facing failure

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T21:24:00+03:00
