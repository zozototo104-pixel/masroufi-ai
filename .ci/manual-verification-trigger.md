# Manual CI verification trigger

Verify the actual Firestore index error fix, not just hiding the message.

Production error:
- FAILED_PRECONDITION: The query requires an index
- caused by salary-cycle details query using userId equality + date range + orderBy(date)

Actual fix:
- readTransactionsForSalaryCycle no longer issues the index-dependent userId+date query
- it reads only the selected salary-cycle date window: date >= cycleStart and date < cycleEndExclusive
- it filters authenticated userId server-side after that bounded date-window query
- it marks partial only when the selected date-window reaches the limit
- tests now explicitly forbid `.where('userId', '==', userId)` inside the salary-cycle helper

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T21:32:00+03:00
