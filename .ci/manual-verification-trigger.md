# Manual CI verification trigger

Final verification for Arabic month/debt NLU fixes.

Must verify:
- "مصروفات شهر أغسطس" is interpreted as salary-cycle August even without saying دورة.
- query_transactions infers Arabic month names/digits from userText/currentUserText.
- query_transactions infers expense/income intent from Arabic text.
- month-scoped debt questions do not use get_balance alone.
- debt questions do not filter out repayment transfers by account/type before computing debt summary.
- "احذف آخر عملية سداد دين" maps to delete_recent_transactions kind=debt_payment count=1 confirmed=true.
- deterministic query replies use tool data, especially currentRemainingForCycleCreditors after repayments.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T09:24:00+03:00
