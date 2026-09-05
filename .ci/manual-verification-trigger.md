# Manual CI verification trigger

Verify that the noisy Live no-audio watchdog message no longer appears to users.

Fix:
- removed the red user-facing message: "الصوت متصل والمايك يرسل..."
- no-audio watchdog is diagnostic-only via console.warn
- real user-facing errors remain only for explicit quota/live_ready/websocket-close failures

Also verify:
- live_ready handshake remains intact
- PalPay income guard path remains intact
- install/audit/tests/TypeScript/build/runtime all pass

Timestamp: 2026-09-05T16:52:00+03:00
