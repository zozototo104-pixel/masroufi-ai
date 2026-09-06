# Manual CI verification trigger

Verify historical debt settlement and bounded salary-cycle recalculation.

Expected behavior:
- Normal pay_debt without explicit date/cycle uses today's date.
- Phrase like "سدد الدين القديم لدورة شهر 8 من رصيد شهر 8" is treated as a historical settlement.
- The DEBT_PAYMENT date is the matched debt date in that cycle, or the target cycle end fallback.
- The payment record stores dateSource, settlementCycleId, settlementCycleName, historicalSettlement, matchedDebtDate, matchedDebtId.
- After successful pay_debt, only the affected settlement salary cycle is recalculated via recalculateCyclesForTransactionChange.
- affectedCycleIds points to the settlement cycle so the UI refreshes the correct cycle.
- No full-ledger rebuild is used for this correction.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T10:10:00+03:00
