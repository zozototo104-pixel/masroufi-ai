# Manual CI verification trigger

Verification requested after fixing Firestore quota exhaustion behavior.

Root causes addressed:
- dashboard stopped fan-out refresh when /api/cloud-health reports RESOURCE_EXHAUSTED
- client quota cooldown uses cached dashboard data instead of hitting all endpoints repeatedly
- concurrent dashboard refreshes are coalesced
- /api/cloud-health negative-caches RESOURCE_EXHAUSTED for 10 minutes
- notifications dashboard limit reduced
- wipe remains authoritative and verified
- READS-06 regression test added

Timestamp: 2026-09-05T10:25:00+03:00
