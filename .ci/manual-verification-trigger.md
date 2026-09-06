# Manual CI verification trigger

Verify NLU fixes for Arabic month, debt repayment deletion, and month-scoped debt.

User-reported issues:
- "مصروفات شهر أغسطس" returned no expenses unless the user said "مصروفات دورة شهر أغسطس".
- "احذف آخر عملية سداد دين" said no debt-payment existed.
- "كم علي دين بشهر 8" still returned the full original debt and ignored a partial repayment.

Fixes:
- parseSalaryCycleMonth now extracts Arabic month names from full user text.
- query_transactions infers salary-cycle month from userText/currentUserText/question/query.
- query_transactions infers expense/income intent from Arabic text.
- debt questions do not apply type/account filters before debt summary, so DEBT_PAYMENT transfers remain visible.
- delete_recent_transactions infers debt_payment from full Arabic user text: سداد/تسديد/سدد/سديت.
- server fallback now handles read/delete financial intents without requiring an amount.
- deterministic replies for query_transactions/get_salary_cycle_summary use tool data directly.
- Live voice prompt explicitly maps month phrases to salary cycles and latest debt-payment deletion to delete_recent_transactions kind=debt_payment.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T09:20:00+03:00
