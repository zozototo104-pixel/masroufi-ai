# Manual CI verification trigger

Verify after updating E2E expectations.

Scope:
- receipt import must split using authoritative server getBalance, not stale client visible balances
- selected liquid account first, other liquid account second, debt only remainder
- partial/unsafe balance blocks receipt split instead of creating debt
- salary-cycle debt summary includes repayments and current remaining debt for cycle creditors
- delete_recent_transactions remains registered and bounded for deleting last 3 expenses / latest debt payment

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-06T08:55:00+03:00
