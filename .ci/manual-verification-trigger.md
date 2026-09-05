# Manual CI verification trigger

Rerun after updating legacy tests for the voice overlap fix.

Scope:
- client blocks duplicate live sessions
- server closes previous live socket for the same user
- stale websocket/audio events ignored
- microphone processor uses silent sink
- barge-in threshold is echo-resistant
- wipe UI test scoped to wipe handler only

Timestamp: 2026-09-05T13:04:00+03:00
