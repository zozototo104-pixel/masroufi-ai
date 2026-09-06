# Manual CI verification trigger

Verify Gemini expense-import model fallback order.

User request:
- re-add gemini-3.7-flash to the import/receipt analysis list
- do not make it the default/first model
- use it directly after cheaper stable models fail, because it previously helped with upload analysis

Expected model order:
1. gemini-2.5-flash-lite
2. gemini-2.5-flash
3. gemini-2.0-flash
4. gemini-3.7-flash

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T08:20:00+03:00
