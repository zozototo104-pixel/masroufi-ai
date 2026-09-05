# Manual CI verification trigger

Verify real Live audio no-response fix.

Root cause addressed:
- after live_ready handshake, client was dropping early user speech before Gemini Live readiness
- user could speak before live_ready, Gemini would receive no request, and the expert would appear silent

Fixes:
- client buffers up to 24 early microphone frames before live_ready
- client flushes buffered frames immediately after live_ready
- output AudioContext is resumed again when Gemini audio arrives
- non-quota liveError and early liveClosed are surfaced explicitly
- previous noisy no-audio message remains removed from UI

Also verify:
- PalPay income guard path remains intact
- install/audit/tests/TypeScript/build/runtime smoke all pass

Timestamp: 2026-09-05T17:05:00+03:00
