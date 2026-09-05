# Manual CI verification trigger

Final run after fixing the current user-reported blockers.

Issues:
- salary dated 27/6 for July salary cycle was still not saving to cloud
- voice was cutting/overlapping like duplicate expert audio

Final fixes included:
- addTransaction now normalizes transaction date before income safety guards
- duplicate late transaction date normalization was removed
- salary duplicate guard uses the normalized salary-cycle window 27→26
- 27/6 and Arabic digits ٢٧/٦ are accepted
- voice buffer changed to 4096 for stability
- barge-in no longer sends the echo frame that triggered interruption
- duplicate/stale live sessions are still guarded

No code changes should follow this trigger unless CI fails.

Timestamp: 2026-09-05T14:04:00+03:00
