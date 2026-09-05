# Manual CI verification trigger

Verify live audio self-interruption fix from Render logs.

Observed logs:
- forwarded audio chunks total 1/2
- immediately serverContent.interrupted
- no RESOURCE_EXHAUSTED shown

Fixes:
- server marks AI output active when forwarding audio
- server drops microphone chunks during AI output to prevent Gemini self-interruption
- explicit client interrupt opens a short override window
- pre-auth pending audio is bounded
- tests assert server-side echo gate

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T14:18:00+03:00
