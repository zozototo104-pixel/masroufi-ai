# Manual CI verification trigger

Verify final Arabic NLU and deletion fixes.

Must verify:
- "مصروفات شهر أغسطس" routes to salary-cycle August without saying دورة.
- Arabic month names/digits are inferred from full user text.
- "دين شهر 8" keeps repayment transfers visible and returns current remaining debt after repayments.
- "احذف آخر عملية سداد دين" maps to delete_recent_transactions kind=debt_payment and explicit Arabic delete text counts as confirmation.
- deterministic query replies use tool data, not Gemini guessing.

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T09:29:00+03:00
