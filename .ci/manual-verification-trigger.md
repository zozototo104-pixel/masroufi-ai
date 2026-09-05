# Manual CI verification trigger

Verify current fixes for user-reported blockers.

Live audio fix:
- server sends type=live_ready only after Gemini Live session connects
- client distinguishes WebSocket open from Gemini Live readiness
- client does not send microphone audio until live_ready arrives
- no-response watchdog only applies after mic frames are actually sent

Finance fix:
- PalPay income uses incomeGuards inside atomicAddTransaction
- cash and PalPay income share the same safe write path

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T16:44:00+03:00
