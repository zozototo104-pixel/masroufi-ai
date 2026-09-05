# Manual CI verification trigger

Verify salary income date saving fix.

Scenario:
- User says: سجل راتب بتاريخ 27/6 وهو راتب شهر 7

Fixes to verify:
- short date 27/6 and Arabic digits ٢٧/٦ are accepted
- addTransaction normalizes date before income duplicate guard
- salary duplicate guard uses salary cycle 27→26 instead of calendar month
- install/tests/TypeScript/build/runtime/audit remain green

Timestamp: 2026-09-05T15:15:00+03:00
