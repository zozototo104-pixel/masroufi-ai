# Manual CI verification trigger

Verify image/file expense import stability.

User issue:
- Uploading an expense image frequently shows: "خدمة تحليل الصور مزدحمة مؤقتاً. جرّب بعد قليل..."
- It works only after retrying later.

Root cause addressed:
- image analysis treated temporary capacity and rate-limit errors the same
- retry/backoff was too shallow
- speculative model names caused unnecessary fallback attempts and latency
- client failed immediately on one 503 instead of retrying
- client allowed another scan request while one was already running

Fixes:
- use stable Gemini Flash fallbacks for receipt/import analysis
- retry 503/UNAVAILABLE with short backoff server-side
- distinguish 429/RESOURCE_EXHAUSTED as GEMINI_RATE_LIMIT_EXCEEDED
- client retries temporary 503 scan failures up to 3 attempts
- client blocks concurrent scan requests
- added IMPORT-01 regression test

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T08:16:00+03:00
