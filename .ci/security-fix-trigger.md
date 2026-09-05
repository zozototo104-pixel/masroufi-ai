# Safe npm audit fix trigger

Run `npm audit fix --package-lock-only --audit-level=moderate` without `--force`.

This time the workflow commits any safe lockfile changes even if npm exits non-zero because firebase-admin/uuid still requires force/breaking handling.

Timestamp: 2026-09-05T13:50:00+03:00
