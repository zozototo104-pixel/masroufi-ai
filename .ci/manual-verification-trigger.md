# Manual CI verification trigger

Final verification after salary-cycle savings and financial behavior fixes.

Scope:
- salary credited on 27/6 belongs to July salary cycle
- expenses from 27/6 through 26/7 belong to July salary cycle
- transfer dates are preserved for cash/PalPay/debt transfers
- cash debt borrowing is inflow, not expense, and not vault-eligible surplus
- savings goals use salary-cycle windows and bounded contribution reads
- reports use salary-cycle month semantics unless calendarMonth is explicit
- real local market tool only, with bounded saved market reads
- voice path low-latency and no refresh storms on close/error
- manual Savings Vault carryover adjustments

Timestamp: 2026-09-05T06:45:00Z
