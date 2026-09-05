# Manual CI verification trigger

Verification after fixing voice cutting/overlap/duplicate expert audio.

Scope:
- client blocks duplicate live WebSocket connects
- client ignores stale websocket/audio events via connection epoch
- microphone processor uses a silent sink to avoid monitoring/feedback
- playback sources are stopped and disconnected
- false barge-in threshold raised to reduce speaker echo interruptions
- server closes previous live socket for the same authenticated user
- LIVE-01 regression test added

Timestamp: 2026-09-05T12:58:00+03:00
