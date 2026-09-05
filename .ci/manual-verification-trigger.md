# Manual CI verification trigger

Verification requested after fixing expired Firebase token handling in backup workflows.

Scope:
- DataBackupModal refreshes Firebase ID token before export/import/wipe
- backup fetch retries once on HTTP 401 / expired token
- CSV export uses full /api/data/export, not bounded /api/transactions
- App dashboard refresh uses a fresh token after backup mutations
- pending sync and targeted vault refresh use fresh tokens
- regression tests AUTH-01/AUTH-02/EXPORT-01 added

Timestamp: 2026-09-05T09:35:00+03:00
