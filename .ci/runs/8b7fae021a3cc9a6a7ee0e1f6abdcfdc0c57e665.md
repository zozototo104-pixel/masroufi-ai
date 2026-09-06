# CI Verification Report

Source commit: 8b7fae021a3cc9a6a7ee0e1f6abdcfdc0c57e665
Run: 34018788395
Install: success
Tests: cancelled
TypeScript: skipped
Build: skipped
Runtime: skipped
Audit: skipped

## failing tests
```text
none
```

## not-ok context
```text
```

## install
```text
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me

added 543 packages, and audited 544 packages in 9s

67 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

## audit
```text
not run
```

## tests
```text
--- tests log head ---

> masrofi-ai@6.0.0 test
> node --import tsx --test tests/auth.test.ts tests/financial.test.ts tests/durability.test.ts tests/authorization.test.ts tests/concurrency.test.ts tests/offline.test.ts tests/market.test.ts tests/e2e.test.ts tests/v6_2_adversarial.test.ts tests/financial_pipeline.test.ts

TAP version 13
# [firebase-admin] No service account was provided. Local ADC may work, but Render requires FIREBASE_SERVICE_ACCOUNT_KEY or a secret file.
# Subtest: AUTH-01: forged masrofi_token_ rejected
ok 1 - AUTH-01: forged masrofi_token_ rejected
  ---
  duration_ms: 1.329782
  type: 'test'
  ...
# Subtest: AUTH-02: missing Authorization header rejected
ok 2 - AUTH-02: missing Authorization header rejected
  ---
  duration_ms: 0.218466
  type: 'test'
  ...
# Subtest: AUTH-03: no default-user fallback — invalid token stays 401
ok 3 - AUTH-03: no default-user fallback — invalid token stays 401
  ---
  duration_ms: 0.329324
  type: 'test'
  ...
# Subtest: AUTH-04: valid Firebase ID token accepted
ok 4 - AUTH-04: valid Firebase ID token accepted
  ---
  duration_ms: 0.228091
  type: 'test'
  ...
# Subtest: AUTH-05: malformed Bearer (no token after prefix) rejected
ok 5 - AUTH-05: malformed Bearer (no token after prefix) rejected
  ---
  duration_ms: 0.232153
  type: 'test'
  ...
# Subtest: AUTH-06: token with empty uid rejected
ok 6 - AUTH-06: token with empty uid rejected
  ---
  duration_ms: 0.219503
  type: 'test'
  ...
# Subtest: AUTH-07: server cannot mint a Firebase identity from an email claim
ok 7 - AUTH-07: server cannot mint a Firebase identity from an email claim
  ---
  duration_ms: 29.922784
  type: 'test'
  ...
# Subtest: WS-01: token not in WebSocket URL — verified via source inspection
ok 8 - WS-01: token not in WebSocket URL — verified via source inspection
  ---
  duration_ms: 2.601385
  type: 'test'
  ...
# Subtest: AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
ok 9 - AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
  ---
  duration_ms: 23.300474
  type: 'test'
  ...
# Subtest: AUTHZ-04: deleteReport ownership check exists
ok 10 - AUTHZ-04: deleteReport ownership check exists
  ---
  duration_ms: 3.25119
  type: 'test'
  ...
# Subtest: AUTHZ-05: deleteCommitment ownership check exists
ok 11 - AUTHZ-05: deleteCommitment ownership check exists
  ---
  duration_ms: 2.717139
  type: 'test'
  ...
# Subtest: AUTHZ-06: update_transaction ownership check exists
ok 12 - AUTHZ-06: update_transaction ownership check exists
  ---
  duration_ms: 3.517081
  type: 'test'
  ...
# Subtest: FIRESTORE-RULES-01: rules file is not empty (CF-7)
ok 13 - FIRESTORE-RULES-01: rules file is not empty (CF-7)
  ---
  duration_ms: 3.957351
  type: 'test'
  ...
# Subtest: TOOL-01: search_market_information declaration REMOVED (HF-1)
ok 14 - TOOL-01: search_market_information declaration REMOVED (HF-1)
  ---
  duration_ms: 5.578087
  type: 'test'
  ...
# Subtest: TOOL-02/03: addTransaction debt guard present (HF-7)
ok 15 - TOOL-02/03: addTransaction debt guard present (HF-7)
  ---
  duration_ms: 2.191017
  type: 'test'
  ...
# Subtest: TOOL-04: ambiguous creditor asks clarification (payDebt)
ok 16 - TOOL-04: ambiguous creditor asks clarification (payDebt)
  ---
  duration_ms: 0.80331
  type: 'test'
  ...
# Subtest: TOOL-05: smart delete asks confirmation even with single match (MF-6)
ok 17 - TOOL-05: smart delete asks confirmation even with single match (MF-6)
  ---
  duration_ms: 3.963789
  type: 'test'
  ...
# Subtest: TOOL-06: memory_search filters by query (MF-2)
ok 18 - TOOL-06: memory_search filters by query (MF-2)
  ---
  duration_ms: 4.804756
  type: 'test'
  ...
# Subtest: TOOL-07: budget read failure propagates error (HF-6)
ok 19 - TOOL-07: budget read failure propagates error (HF-6)
  ---
  duration_ms: 2.409399
  type: 'test'
  ...
# Subtest: TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)
ok 20 - TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)
  ---
  duration_ms: 2.877171
  type: 'test'
  ...
# Subtest: TOOL-09: commitments support paid/cancelled status (MF-1)
ok 21 - TOOL-09: commitments support paid/cancelled status (MF-1)
  ---
  duration_ms: 2.311918
  type: 'test'
  ...
# Subtest: TOOL-10: sendPalPayPayment validates amount, balance, phone (HF-3)
ok 22 - TOOL-10: sendPalPayPayment validates amount, balance, phone (HF-3)
  ---
  duration_ms: 10.358939
  type: 'test'
  ...
# Subtest: CONC-01: add_transaction commits through Firestore atomic path, not FakeDb pending fallback
ok 23 - CONC-01: add_transaction commits through Firestore atomic path, not FakeDb pending fallback
  ---
  duration_ms: 15.204708
  type: 'test'
  ...
# Subtest: CONC-02: PalPay expense uses atomic guard (same code path)
ok 24 - CONC-02: PalPay expense uses atomic guard (same code path)
  ---
  duration_ms: 2.55367
  type: 'test'
  ...
# Subtest: CONC-03: payDebt uses atomicPayDebt (concurrent payment protection)
ok 25 - CONC-03: payDebt uses atomicPayDebt (concurrent payment protection)
  ---
  duration_ms: 3.955288
  type: 'test'
  ...
# Subtest: CONC-04: same operationId executes once (idempotency layer)
ok 26 - CONC-04: same operationId executes once (idempotency layer)
  ---
  duration_ms: 0.897978
  type: 'test'
  ...
# Subtest: CONC-05: concurrent update + expense preserves invariant (NEGATIVE_CASH_RESULT guard)
ok 27 - CONC-05: concurrent update + expense preserves invariant (NEGATIVE_CASH_RESULT guard)
  ---
  duration_ms: 3.79366
  type: 'test'
  ...
# Subtest: CONC-06: atomicAddTransaction exists in atomicOps.ts
ok 28 - CONC-06: atomicAddTransaction exists in atomicOps.ts
  ---
  duration_ms: 1.093162
  type: 'test'
  ...
# Subtest: CONC-07: atomicPayDebt recomputes creditor remaining through the shared domain core
ok 29 - CONC-07: atomicPayDebt recomputes creditor remaining through the shared domain core
  ---
  duration_ms: 0.941164
  type: 'test'
  ...
# Subtest: CONC-08: atomicOps has no circular dependency on tools.ts
ok 30 - CONC-08: atomicOps has no circular dependency on tools.ts
  ---
  duration_ms: 0.702551
  type: 'test'
  ...
# Subtest: CONC-08B: payDebt open-creditor list delegates debt math to the shared domain core
ok 31 - CONC-08B: payDebt open-creditor list delegates debt math to the shared domain core
  ---
  duration_ms: 2.856309
  type: 'test'
  ...
# Subtest: CONC-09: stale pending idempotency keys never auto-reexecute financial mutations
ok 32 - CONC-09: stale pending idempotency keys never auto-reexecute financial mutations
  ---
  duration_ms: 0.609156
  type: 'test'
  ...
# Subtest: CONC-10: completed and indeterminate outcomes are terminal behavioral states
ok 33 - CONC-10: completed and indeterminate outcomes are terminal behavioral states
  ---
  duration_ms: 1.050005
  type: 'test'
  ...
# Subtest: CONC-11: transaction updates revalidate balances and write inside one Firestore transaction
ok 34 - CONC-11: transaction updates revalidate balances and write inside one Firestore transaction
  ---
  duration_ms: 3.504899
  type: 'test'
  ...
# Subtest: CONC-12: direct and smart transaction deletion revalidate and delete atomically
ok 35 - CONC-12: direct and smart transaction deletion revalidate and delete atomically
  ---
  duration_ms: 4.940789
  type: 'test'
  ...
# Subtest: CONC-13: reviewed receipt/import lines are prepared directly and persisted by one bounded batch
ok 36 - CONC-13: reviewed receipt/import lines are prepared directly and persisted by one bounded batch
  ---
  duration_ms: 3.678152
--- tests log tail ---
  ...
# Subtest: MARKET-23: Bank of Israel FX payload parser preserves representative source date
ok 206 - MARKET-23: Bank of Israel FX payload parser preserves representative source date
  ---
  duration_ms: 0.377977
  type: 'test'
  ...
# Subtest: MARKET-24: converted FX market results expose source/date metadata and reject Infinity
ok 207 - MARKET-24: converted FX market results expose source/date metadata and reject Infinity
  ---
  duration_ms: 0.900886
  type: 'test'
  ...
# Subtest: MARKET-25: saved and live market results spread FX metadata when conversion succeeds
ok 208 - MARKET-25: saved and live market results spread FX metadata when conversion succeeds
  ---
  duration_ms: 5.456272
  type: 'test'
  ...
# Subtest: OFF-01: FakeDb.set returns durability=pending on Firestore failure
ok 209 - OFF-01: FakeDb.set returns durability=pending on Firestore failure
  ---
  duration_ms: 7.085603
  type: 'test'
  ...
# Subtest: OFF-02: offline queue persists in IndexedDB (survives browser reload)
ok 210 - OFF-02: offline queue persists in IndexedDB (survives browser reload)
  ---
  duration_ms: 2.038231
  type: 'test'
  ...
# Subtest: OFF-03: queue keyed by userId (survives Cloud Run restart, client-side)
ok 211 - OFF-03: queue keyed by userId (survives Cloud Run restart, client-side)
  ---
  duration_ms: 1.250493
  type: 'test'
  ...
# Subtest: OFF-04: syncPendingOps attempts to sync on fetchData
ok 212 - OFF-04: syncPendingOps attempts to sync on fetchData
  ---
  duration_ms: 2.085406
  type: 'test'
  ...
# Subtest: OFF-05: retry does not duplicate after the operation completed
ok 213 - OFF-05: retry does not duplicate after the operation completed
  ---
  duration_ms: 0.463321
  type: 'test'
  ...
# Subtest: OFF-06: server committed but response lost — retry returns cached result
ok 214 - OFF-06: server committed but response lost — retry returns cached result
  ---
  duration_ms: 0.843605
  type: 'test'
  ...
# Subtest: OFF-06B: offline income parser cannot manufacture server business confirmations
ok 215 - OFF-06B: offline income parser cannot manufacture server business confirmations
  ---
  duration_ms: 4.189207
  type: 'test'
  ...
# Subtest: OFF-07: Login A → logout → Login B cannot see/sync A queue
ok 216 - OFF-07: Login A → logout → Login B cannot see/sync A queue
  ---
  duration_ms: 2.108966
  type: 'test'
  ...
# Subtest: OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
ok 217 - OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
  ---
  duration_ms: 1.05161
  type: 'test'
  ...
# Subtest: OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
ok 218 - OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
  ---
  duration_ms: 1.11621
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
ok 219 - ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
  ---
  duration_ms: 10.250484
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
ok 220 - ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
  ---
  duration_ms: 1.710567
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
ok 221 - TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
  ---
  duration_ms: 1.673143
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
ok 222 - TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
  ---
  duration_ms: 0.650133
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-03: transferMoney has NO direct write fallback
ok 223 - TRANSFER-CONC-03: transferMoney has NO direct write fallback
  ---
  duration_ms: 2.767865
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
ok 224 - OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
  ---
  duration_ms: 0.755593
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
ok 225 - OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
  ---
  duration_ms: 0.628779
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
ok 226 - OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
  ---
  duration_ms: 1.291833
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
ok 227 - OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
  ---
  duration_ms: 0.790051
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
ok 228 - OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
  ---
  duration_ms: 0.967359
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
ok 229 - UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
  ---
  duration_ms: 0.694118
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
ok 230 - UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
  ---
  duration_ms: 0.585063
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
ok 231 - UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
  ---
  duration_ms: 1.527346
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
ok 232 - UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
  ---
  duration_ms: 2.254795
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-01: addTransaction rejects on partial snapshot
ok 233 - PARTIAL-STATE-01: addTransaction rejects on partial snapshot
  ---
  duration_ms: 5.645239
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-02: transferMoney rejects on partial balance
ok 234 - PARTIAL-STATE-02: transferMoney rejects on partial balance
  ---
  duration_ms: 1.860993
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-03: payDebt rejects on partial snapshot
ok 235 - PARTIAL-STATE-03: payDebt rejects on partial snapshot
  ---
  duration_ms: 1.983198
  type: 'test'
  ...
# Subtest: FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
ok 236 - FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
  ---
  duration_ms: 0.556373
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
ok 237 - STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
  ---
  duration_ms: 1.900401
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
ok 238 - STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
  ---
  duration_ms: 2.360598
  type: 'test'
  ...
# Subtest: SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
ok 239 - SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
  ---
  duration_ms: 0.830256
  type: 'test'
  ...
# Subtest: IDEM-01: dispatchFinancialCommand passes operationId through args
ok 240 - IDEM-01: dispatchFinancialCommand passes operationId through args
  ---
  duration_ms: 0.496473
  type: 'test'
  ...
1..240
# tests 240
# suites 0
# pass 240
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1810.132776
```

## lint
```text
not run
```

## build
```text
not run
```

