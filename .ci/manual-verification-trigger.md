# Manual CI verification trigger

Verify explicit Gemini Live quota handling.

Reason:
- User confirmed the same behavior previously happened when Gemini Live API quota was exhausted.

Fixes:
- server classifies RESOURCE_EXHAUSTED / quota / rate-limit / 429 Live API errors
- server sends liveQuotaExceeded=true to the client
- client stops voice UI and shows a clear Arabic quota message
- existing echo/self-interruption gate remains intact

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T14:40:00+03:00
