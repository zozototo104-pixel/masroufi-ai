# Manual CI verification trigger

Verification requested after global Firestore reads fixes based on AI Studio notes.

Scope:
- account balance snapshot for daily financial mutations
- getBalance O(1) snapshot read with explicit repair/bootstrap
- expense/update/delete/payDebt/PalPay paths avoid full-ledger reads
- bounded financial decision context, treasurer report, duplicate audit, duplicate repairs, commitments
- import rebuilds account balance snapshot and clears stale snapshot if repair fails
- regression tests READS-* added

Timestamp: 2026-09-05T07:05:00Z
