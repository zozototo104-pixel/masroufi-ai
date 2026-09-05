# Manual CI verification trigger

Verification requested after fixing the root cause of Wipe reporting success while data remained.

Root-cause fixes:
- wipeAllUserData uses firebaseAdminDb, not getDb(token)
- wipe no longer swallows deletion errors
- wipe deletes root idempotency collections and savings contribution subcollections
- wipe verifies every visible collection is empty before returning success
- UI only shows success when verifiedEmpty=true and immediately zeros visible counters
- regression test WIPE-01 added

Timestamp: 2026-09-05T10:05:00+03:00
