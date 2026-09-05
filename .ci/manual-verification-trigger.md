# Manual CI verification trigger

Verify salary-cycle navigation UI and bounded cycle operations.

User request:
- navigate between salary cycles/months
- view income items, expense items, transfers, and vault carryover per cycle
- see current cycle period clearly in the UI
- delete one salary cycle safely without touching other months

Changes:
- dashboard vault card now says دورات الراتب
- current salary cycle period is clearer on dashboard
- vault modal has الشهر السابق / الشهر التالي buttons
- selected cycle card is pinned above the picker
- cycle details show income, expenses, internal transfers, vault carryover, and category summary
- backend existing bounded cycle APIs remain in use

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T20:54:00+03:00
