# Manual CI verification trigger

Rerun after fixing TypeScript field name in salary guard payload.

Previous failure:
- src/server/tools.ts: Property 'endIso' does not exist on SalaryCyclePeriod

Fix:
- use salaryCycleForGuard.cycleEnd

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T15:05:00+03:00
