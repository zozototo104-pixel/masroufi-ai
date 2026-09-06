# Manual CI verification trigger

Verify Gemini quota handling and usage reduction.

User issue:
- Gemini image/live quota gets exhausted quickly.
- Need switching between API keys without making one exhausted key block all requests.
- Need reduce excessive Gemini usage, especially repeated image uploads.

Fixes:
- added GEMINI_API_KEYS key pool support in addition to GEMINI_API_KEY
- key IDs are hashed; raw API keys are never logged
- 429/RESOURCE_EXHAUSTED puts the key in cooldown and tries the next key
- 503/UNAVAILABLE puts a shorter cooldown and can try the next key
- /api/scan-receipt uses key pool rotation
- Gemini Live connection uses key pool fallback during session creation
- failed Live sessionPromise is cleared so a second key can connect
- identical receipt uploads use a short in-memory cache to avoid another Gemini request
- response includes safe diagnostics: geminiKeyId, geminiKeySource, keyFallbackUsed, modelFallbackUsed

Expected env format:
GEMINI_API_KEYS=key1,key2,key3

Important:
Keys from the same Google project may still share project-level quota. Best result is multiple projects/tiers.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T09:40:00+03:00
