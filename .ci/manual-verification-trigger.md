# Manual CI verification trigger

Verify iPhone/mobile layout fix.

User issue:
- Savings Vault modal shows salary cycle details but the screen cannot scroll down to see all items on iPhone/Safari.

Fixes:
- added mobile-modal-backdrop and mobile-modal-panel CSS utilities with 100dvh, safe-area insets, overflow-y auto, and -webkit-overflow-scrolling touch
- converted Vault/Savings/Budgets/Commitments/Reports/Report Viewer/Chat/Scanner modals to mobile-safe layouts
- Vault dates remain readable in RTL
- added MOBILE-01 regression test

Expected gates:
- install
- audit
- tests
- TypeScript
- build
- runtime smoke

Timestamp: 2026-09-05T21:33:00+03:00
