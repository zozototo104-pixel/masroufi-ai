# Manual CI verification trigger

Final verification after fixing the false Live no-response watchdog.

Issue shown in screenshot:
- app displayed: mic is sending but no Gemini Live audio response
- this was triggered before Gemini Live readiness was explicitly confirmed

Fix:
- server sends type=live_ready only after Gemini Live connects
- client tracks liveReadyRef separately from WebSocket open
- client does not send microphone audio until live_ready arrives
- liveReadyWatchdog handles Gemini readiness delays separately
- responseWatchdog only applies after audio is actually sent

Also verify:
- PalPay income guard path remains intact
- install/audit/tests/typecheck/build/runtime smoke all pass

Timestamp: 2026-09-05T16:49:00+03:00
