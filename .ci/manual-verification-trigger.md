# Manual CI verification trigger

Rerun after fixing the mobile modal regression-test marker.

Verify current HEAD:
- locked vault account semantics
- manual vault carryover/release integration with accountBalances.vault
- cycle close lockVault explicit behavior
- iPhone-safe modal scrolling
- all tests/typecheck/build/runtime gates

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T22:41:00+03:00
