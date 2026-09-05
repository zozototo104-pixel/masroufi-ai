# Manual CI verification trigger

Verify fixes after user reported:
- salary on 27/6 still not saving to cloud
- voice still cuts and overlaps

Fixes:
- addTransaction now normalizes transaction date before income safety guards
- duplicate late date normalization removed
- salary duplicate guard uses normalized salary-cycle window
- voice uses 4096 buffer for stable capture
- barge-in no longer sends the same echo frame that triggered interruption

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T13:58:00+03:00
