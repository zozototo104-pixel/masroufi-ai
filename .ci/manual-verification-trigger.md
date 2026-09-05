# Manual CI verification trigger

Verification after fixing wipe not deleting/appearing not deleted.

Scope:
- server wipe remains Admin Firestore + verifiedEmpty
- backup modal clears IndexedDB LKGS caches after verified wipe
- backup modal clears pending offline queues after verified wipe
- backup modal no longer triggers full masrofi:refresh after wipe
- App listens to masrofi:data-wiped and clears in-memory dashboard state
- regression tests updated for local cache/pending queue wipe

Timestamp: 2026-09-05T11:43:00+03:00
