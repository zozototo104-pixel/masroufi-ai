# Manual CI verification trigger

Verify historical debt settlement behavior.

User question:
- If the user says: "سدد لي الدين القديم لدورة شهر 8 من رصيد شهر 8" should the debt payment be dated today and counted in salary cycle 9?

Expected behavior:
- Normal pay_debt without date/cycle uses today's date.
- If the user says from a salary-cycle balance, for a cycle month, at debt date/time, the payment is a historical settlement.
- pay_debt resolves the settlement date to the matched original debt date in the target cycle, or falls back to the target salary-cycle end.
- DEBT_PAYMENT record stores dateSource, settlementCycleId, settlementCycleName, historicalSettlement, matchedDebtDate, matchedDebtId.
- affectedCycleIds points to the settlement salary cycle, not necessarily today's cycle.
- Voice/text prompts instruct Gemini not to place this settlement in today's cycle.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T10:05:00+03:00
