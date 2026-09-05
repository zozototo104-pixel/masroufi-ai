# Safe npm audit fix trigger

Run `npm audit fix --package-lock-only --audit-level=moderate` without `--force`.

Goal:
- fix the express/body-parser/qs advisories safely if npm can update the lockfile
- do not downgrade firebase-admin or apply breaking changes

Timestamp: 2026-09-05T13:45:00+03:00
