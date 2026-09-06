# Manual CI verification trigger

Verify final expense-import model order requested by the user.

Expected order:
1. gemini-2.5-flash-lite
2. gemini-2.5-flash
3. gemini-3.7-flash

Rules:
- Gemini 3.7 Flash is present as a late fallback.
- It is not the default/first model.
- If the cheap 2.5 models fail, the importer tries Gemini 3.7 Flash directly.
- Do not insert gemini-2.0-flash before 3.7 in this import path.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T08:25:00+03:00
