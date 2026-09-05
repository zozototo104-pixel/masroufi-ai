# Manual CI verification trigger

Verify real fix for expert not responding.

Changes:
- client buffers early microphone frames before Gemini live_ready instead of dropping them
- client flushes buffered frames after live_ready
- output AudioContext resumes again when Gemini audio arrives
- client handles liveError/liveClosed explicitly
- server logs when live_ready is sent

Also verify:
- PalPay income guard path remains intact
- install/audit/tests/TypeScript/build/runtime smoke all pass

Timestamp: 2026-09-05T17:14:00+03:00
