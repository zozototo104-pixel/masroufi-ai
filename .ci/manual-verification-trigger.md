# Manual CI verification trigger

Verify close-month vault command routing and liquidity math.

User issue:
- While active on salary cycle 08-2026 with 445 ₪ remaining, user said: "حوّلي المبلغ عالخزنة واقفلي الشهر".
- Assistant routed it as a creditor/debt overpayment/fائض سداد دائن instead of closing the salary cycle and locking the surplus in Savings Vault.
- Dashboard still showed 445 available even though cash and PalPay were 0 after the bad debt-payment route.

Fixes:
- recalculate_salary_cycle is now declared to Gemini as a tool, not only registered as a backend handler.
- "حول المتبقي للخزنة / اقفل الشهر / اقفل الدورة / رحّل الفائض" must use recalculate_salary_cycle with lockVault=true, closeCycle=true, transferToVault=true.
- Voice auth sends activeSalaryCycleId/name/month/year from the UI to the server.
- Live prompt includes the active UI salary cycle.
- Live tool execution injects active salary cycle context into tool args.
- Recalculate uses active UI salary cycle if the user says "الشهر/الدورة" without specifying month.
- Server overrides misrouted close-vault text/live tool calls before execution.
- Salary-cycle surplus subtracts debt repayments as liquidity outflow: debt repayment is not a new expense, but it reduces money available for vault.
- Dashboard spendable subtracts debtPaid for the active cycle.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T10:44:00+03:00
