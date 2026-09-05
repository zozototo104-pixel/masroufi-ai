# Manual CI verification trigger

Final verification after applying AI Studio Firestore-read notes globally.

Scope:
- account balance snapshot for daily mutations
- getBalance O(1) snapshot read with explicit repair/bootstrap
- bounded add/update/delete/payDebt/PalPay paths
- bounded decision context, treasurer reports, duplicate audit, duplicate repairs, commitments
- import/wipe keep account/vault snapshots consistent
- READS-* regression tests

Timestamp: 2026-09-05T07:25:00Z
