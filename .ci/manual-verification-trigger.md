# Manual CI verification trigger

Final verification after fixing salary save on short date 27/6.

Scenario:
- User says: سجلي راتب بتاريخ 27/6 وهو راتب شهر 7

Expected:
- 27/6 and ٢٧/٦ normalize to current-year 06-27
- salary cycle is vault_YYYY_07
- addTransaction normalizes date before income duplicate guard
- salary duplicate guard queries 27/06→26/07 window
- install/tests/TypeScript/build/runtime/audit all succeed

Timestamp: 2026-09-05T15:25:00+03:00
