# Manual CI verification trigger

Verification requested after auditing AI Studio notes against current main.

Risk fixes included:
- budget partial fallback no longer publishes sampled or mixed-period totals
- UI no longer recomputes calendar budgets from salary-cycle transaction slices
- income duplicate guard is month-bounded instead of full-ledger
- budget warning side-effect is month/category-bounded when no pre-read ledger exists
- vault spendable balance is displayed separately from cash/PalPay/debt
- bounded idempotent repair path for stale savingsVault meta

Timestamp: 2026-09-05T06:05:00Z
