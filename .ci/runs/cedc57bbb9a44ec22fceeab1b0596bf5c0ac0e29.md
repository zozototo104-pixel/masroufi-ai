# CI Verification Report

Source commit: cedc57bbb9a44ec22fceeab1b0596bf5c0ac0e29
Run: 34027336427
Install: success
Tests: failure
TypeScript: cancelled
Build: skipped
Runtime: skipped
Audit: skipped

## failing tests
```text
not ok 142 - VAULT-14: Savings Vault is separated from cash, PalPay, debt, and Personal Voice
  ---
  duration_ms: 13.127468
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:42160'
  failureType: 'testCodeFailure'
  error: 'spendable card must be scoped to the active salary cycle, not global vault subtraction'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:846:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: NLU-01: Arabic month and debt phrases route to salary-cycle tools without saying دورة
ok 143 - NLU-01: Arabic month and debt phrases route to salary-cycle tools without saying دورة
  ---
  duration_ms: 7.418735
  type: 'test'
  ...
# Subtest: VAULT-14A: close-month remainder goes to salary-cycle vault lock, not debt payment
ok 144 - VAULT-14A: close-month remainder goes to salary-cycle vault lock, not debt payment
  ---
  duration_ms: 9.541161
  type: 'test'
  ...
# Subtest: VAULT-14D: UI provides direct repair for misrouted creditor-surplus vault close
ok 145 - VAULT-14D: UI provides direct repair for misrouted creditor-surplus vault close
  ---
  duration_ms: 8.245401
  type: 'test'
  ...
```

## not-ok context
```text
842-ok 140 - VAULT-12: Firestore read-cost regressions are guarded for notifications, reports, and refresh
843-  ---
844-  duration_ms: 14.19592
845-  type: 'test'
846-  ...
847-# Subtest: VAULT-13: Savings Vault refuses unsafe partial or saturated authoritative commits
848-ok 141 - VAULT-13: Savings Vault refuses unsafe partial or saturated authoritative commits
849-  ---
850-  duration_ms: 4.060789
851-  type: 'test'
852-  ...
853-# Subtest: VAULT-14: Savings Vault is separated from cash, PalPay, debt, and Personal Voice
854:not ok 142 - VAULT-14: Savings Vault is separated from cash, PalPay, debt, and Personal Voice
855-  ---
856-  duration_ms: 13.127468
857-  type: 'test'
858-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:42160'
859-  failureType: 'testCodeFailure'
860:  error: 'spendable card must be scoped to the active salary cycle, not global vault subtraction'
861:  code: 'ERR_ASSERTION'
862:  name: 'AssertionError'
863-  expected: true
864-  actual: false
865-  operator: '=='
866-  stack: |-
867-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:846:10)
868-    async Test.run (node:internal/test_runner/test:1054:7)
869-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
870-  ...
871-# Subtest: NLU-01: Arabic month and debt phrases route to salary-cycle tools without saying دورة
872-ok 143 - NLU-01: Arabic month and debt phrases route to salary-cycle tools without saying دورة
873-  ---
874-  duration_ms: 7.418735
```

## install
```text
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me

added 543 packages, and audited 544 packages in 11s

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
  duration_ms: 1.54542
  type: 'test'
  ...
# Subtest: AUTH-02: missing Authorization header rejected
ok 2 - AUTH-02: missing Authorization header rejected
  ---
  duration_ms: 0.279314
  type: 'test'
  ...
# Subtest: AUTH-03: no default-user fallback — invalid token stays 401
ok 3 - AUTH-03: no default-user fallback — invalid token stays 401
  ---
  duration_ms: 0.407434
  type: 'test'
  ...
# Subtest: AUTH-04: valid Firebase ID token accepted
ok 4 - AUTH-04: valid Firebase ID token accepted
  ---
  duration_ms: 0.286925
  type: 'test'
  ...
# Subtest: AUTH-05: malformed Bearer (no token after prefix) rejected
ok 5 - AUTH-05: malformed Bearer (no token after prefix) rejected
  ---
  duration_ms: 0.234477
  type: 'test'
  ...
# Subtest: AUTH-06: token with empty uid rejected
ok 6 - AUTH-06: token with empty uid rejected
  ---
  duration_ms: 0.225825
  type: 'test'
  ...
# Subtest: AUTH-07: server cannot mint a Firebase identity from an email claim
ok 7 - AUTH-07: server cannot mint a Firebase identity from an email claim
  ---
  duration_ms: 34.169835
  type: 'test'
  ...
# Subtest: WS-01: token not in WebSocket URL — verified via source inspection
ok 8 - WS-01: token not in WebSocket URL — verified via source inspection
  ---
  duration_ms: 4.489555
  type: 'test'
  ...
# Subtest: AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
ok 9 - AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
  ---
  duration_ms: 27.336798
  type: 'test'
  ...
# Subtest: AUTHZ-04: deleteReport ownership check exists
ok 10 - AUTHZ-04: deleteReport ownership check exists
  ---
  duration_ms: 6.343922
  type: 'test'
  ...
# Subtest: AUTHZ-05: deleteCommitment ownership check exists
ok 11 - AUTHZ-05: deleteCommitment ownership check exists
  ---
  duration_ms: 7.055566
  type: 'test'
  ...
# Subtest: AUTHZ-06: update_transaction ownership check exists
ok 12 - AUTHZ-06: update_transaction ownership check exists
  ---
  duration_ms: 8.858871
  type: 'test'
  ...
# Subtest: FIRESTORE-RULES-01: rules file is not empty (CF-7)
ok 13 - FIRESTORE-RULES-01: rules file is not empty (CF-7)
  ---
  duration_ms: 5.948627
  type: 'test'
  ...
# Subtest: TOOL-01: search_market_information declaration REMOVED (HF-1)
ok 14 - TOOL-01: search_market_information declaration REMOVED (HF-1)
  ---
  duration_ms: 4.187997
  type: 'test'
  ...
# Subtest: TOOL-02/03: addTransaction debt guard present (HF-7)
ok 15 - TOOL-02/03: addTransaction debt guard present (HF-7)
  ---
  duration_ms: 5.581523
  type: 'test'
  ...
# Subtest: TOOL-04: ambiguous creditor asks clarification (payDebt)
ok 16 - TOOL-04: ambiguous creditor asks clarification (payDebt)
  ---
  duration_ms: 2.411605
  type: 'test'
  ...
# Subtest: TOOL-05: smart delete asks confirmation even with single match (MF-6)
ok 17 - TOOL-05: smart delete asks confirmation even with single match (MF-6)
  ---
  duration_ms: 15.510018
  type: 'test'
  ...
# Subtest: TOOL-06: memory_search filters by query (MF-2)
ok 18 - TOOL-06: memory_search filters by query (MF-2)
  ---
  duration_ms: 7.781113
  type: 'test'
  ...
# Subtest: TOOL-07: budget read failure propagates error (HF-6)
ok 19 - TOOL-07: budget read failure propagates error (HF-6)
  ---
  duration_ms: 6.240119
  type: 'test'
  ...
# Subtest: TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)
ok 20 - TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)
  ---
  duration_ms: 5.489646
  type: 'test'
  ...
# Subtest: TOOL-09: commitments support paid/cancelled status (MF-1)
ok 21 - TOOL-09: commitments support paid/cancelled status (MF-1)
  ---
  duration_ms: 5.516746
  type: 'test'
  ...
# Subtest: TOOL-10: sendPalPayPayment validates amount, balance, phone (HF-3)
ok 22 - TOOL-10: sendPalPayPayment validates amount, balance, phone (HF-3)
  ---
  duration_ms: 6.205257
  type: 'test'
  ...
# Subtest: CONC-01: add_transaction commits through Firestore atomic path, not FakeDb pending fallback
ok 23 - CONC-01: add_transaction commits through Firestore atomic path, not FakeDb pending fallback
  ---
  duration_ms: 16.408851
  type: 'test'
  ...
# Subtest: CONC-02: PalPay expense uses atomic guard (same code path)
ok 24 - CONC-02: PalPay expense uses atomic guard (same code path)
  ---
  duration_ms: 3.559626
  type: 'test'
  ...
# Subtest: CONC-03: payDebt uses atomicPayDebt (concurrent payment protection)
ok 25 - CONC-03: payDebt uses atomicPayDebt (concurrent payment protection)
  ---
  duration_ms: 4.428734
  type: 'test'
  ...
# Subtest: CONC-04: same operationId executes once (idempotency layer)
ok 26 - CONC-04: same operationId executes once (idempotency layer)
  ---
  duration_ms: 1.328479
  type: 'test'
  ...
# Subtest: CONC-05: concurrent update + expense preserves invariant (NEGATIVE_CASH_RESULT guard)
ok 27 - CONC-05: concurrent update + expense preserves invariant (NEGATIVE_CASH_RESULT guard)
  ---
  duration_ms: 4.725304
  type: 'test'
  ...
# Subtest: CONC-06: atomicAddTransaction exists in atomicOps.ts
ok 28 - CONC-06: atomicAddTransaction exists in atomicOps.ts
  ---
  duration_ms: 1.505621
  type: 'test'
  ...
# Subtest: CONC-07: atomicPayDebt recomputes creditor remaining through the shared domain core
ok 29 - CONC-07: atomicPayDebt recomputes creditor remaining through the shared domain core
  ---
  duration_ms: 1.516848
  type: 'test'
  ...
# Subtest: CONC-08: atomicOps has no circular dependency on tools.ts
ok 30 - CONC-08: atomicOps has no circular dependency on tools.ts
  ---
  duration_ms: 1.121672
  type: 'test'
  ...
# Subtest: CONC-08B: payDebt open-creditor list delegates debt math to the shared domain core
ok 31 - CONC-08B: payDebt open-creditor list delegates debt math to the shared domain core
  ---
  duration_ms: 3.786572
  type: 'test'
  ...
# Subtest: CONC-09: stale pending idempotency keys never auto-reexecute financial mutations
ok 32 - CONC-09: stale pending idempotency keys never auto-reexecute financial mutations
  ---
  duration_ms: 0.717263
  type: 'test'
  ...
# Subtest: CONC-10: completed and indeterminate outcomes are terminal behavioral states
ok 33 - CONC-10: completed and indeterminate outcomes are terminal behavioral states
  ---
  duration_ms: 1.253388
  type: 'test'
  ...
# Subtest: CONC-11: transaction updates revalidate balances and write inside one Firestore transaction
ok 34 - CONC-11: transaction updates revalidate balances and write inside one Firestore transaction
  ---
  duration_ms: 6.916852
  type: 'test'
  ...
# Subtest: CONC-12: direct and smart transaction deletion revalidate and delete atomically
ok 35 - CONC-12: direct and smart transaction deletion revalidate and delete atomically
  ---
  duration_ms: 5.271513
  type: 'test'
  ...
# Subtest: CONC-13: reviewed receipt/import lines are prepared directly and persisted by one bounded batch
ok 36 - CONC-13: reviewed receipt/import lines are prepared directly and persisted by one bounded batch
  ---
  duration_ms: 6.642134
--- tests log tail ---
  ...
# Subtest: MARKET-23: Bank of Israel FX payload parser preserves representative source date
ok 211 - MARKET-23: Bank of Israel FX payload parser preserves representative source date
  ---
  duration_ms: 6.096056
  type: 'test'
  ...
# Subtest: MARKET-24: converted FX market results expose source/date metadata and reject Infinity
ok 212 - MARKET-24: converted FX market results expose source/date metadata and reject Infinity
  ---
  duration_ms: 0.951761
  type: 'test'
  ...
# Subtest: MARKET-25: saved and live market results spread FX metadata when conversion succeeds
ok 213 - MARKET-25: saved and live market results spread FX metadata when conversion succeeds
  ---
  duration_ms: 6.419915
  type: 'test'
  ...
# Subtest: OFF-01: FakeDb.set returns durability=pending on Firestore failure
ok 214 - OFF-01: FakeDb.set returns durability=pending on Firestore failure
  ---
  duration_ms: 10.097145
  type: 'test'
  ...
# Subtest: OFF-02: offline queue persists in IndexedDB (survives browser reload)
ok 215 - OFF-02: offline queue persists in IndexedDB (survives browser reload)
  ---
  duration_ms: 1.963741
  type: 'test'
  ...
# Subtest: OFF-03: queue keyed by userId (survives Cloud Run restart, client-side)
ok 216 - OFF-03: queue keyed by userId (survives Cloud Run restart, client-side)
  ---
  duration_ms: 4.479309
  type: 'test'
  ...
# Subtest: OFF-04: syncPendingOps attempts to sync on fetchData
ok 217 - OFF-04: syncPendingOps attempts to sync on fetchData
  ---
  duration_ms: 6.499213
  type: 'test'
  ...
# Subtest: OFF-05: retry does not duplicate after the operation completed
ok 218 - OFF-05: retry does not duplicate after the operation completed
  ---
  duration_ms: 0.487923
  type: 'test'
  ...
# Subtest: OFF-06: server committed but response lost — retry returns cached result
ok 219 - OFF-06: server committed but response lost — retry returns cached result
  ---
  duration_ms: 0.965061
  type: 'test'
  ...
# Subtest: OFF-06B: offline income parser cannot manufacture server business confirmations
ok 220 - OFF-06B: offline income parser cannot manufacture server business confirmations
  ---
  duration_ms: 4.319142
  type: 'test'
  ...
# Subtest: OFF-07: Login A → logout → Login B cannot see/sync A queue
ok 221 - OFF-07: Login A → logout → Login B cannot see/sync A queue
  ---
  duration_ms: 2.732329
  type: 'test'
  ...
# Subtest: OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
ok 222 - OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
  ---
  duration_ms: 1.681933
  type: 'test'
  ...
# Subtest: OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
ok 223 - OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
  ---
  duration_ms: 1.589717
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
ok 224 - ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
  ---
  duration_ms: 13.166074
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
ok 225 - ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
  ---
  duration_ms: 2.2333
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
ok 226 - TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
  ---
  duration_ms: 2.465464
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
ok 227 - TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
  ---
  duration_ms: 1.00563
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-03: transferMoney has NO direct write fallback
ok 228 - TRANSFER-CONC-03: transferMoney has NO direct write fallback
  ---
  duration_ms: 5.823301
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
ok 229 - OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
  ---
  duration_ms: 0.973403
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
ok 230 - OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
  ---
  duration_ms: 1.367097
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
ok 231 - OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
  ---
  duration_ms: 1.879537
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
ok 232 - OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
  ---
  duration_ms: 1.157025
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
ok 233 - OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
  ---
  duration_ms: 2.434638
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
ok 234 - UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
  ---
  duration_ms: 1.005661
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
ok 235 - UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
  ---
  duration_ms: 1.070446
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
ok 236 - UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
  ---
  duration_ms: 1.489768
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
ok 237 - UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
  ---
  duration_ms: 1.827999
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-01: addTransaction rejects on partial snapshot
ok 238 - PARTIAL-STATE-01: addTransaction rejects on partial snapshot
  ---
  duration_ms: 3.48864
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-02: transferMoney rejects on partial balance
ok 239 - PARTIAL-STATE-02: transferMoney rejects on partial balance
  ---
  duration_ms: 2.218558
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-03: payDebt rejects on partial snapshot
ok 240 - PARTIAL-STATE-03: payDebt rejects on partial snapshot
  ---
  duration_ms: 2.066743
  type: 'test'
  ...
# Subtest: FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
ok 241 - FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
  ---
  duration_ms: 0.666558
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
ok 242 - STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
  ---
  duration_ms: 2.161393
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
ok 243 - STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
  ---
  duration_ms: 3.357226
  type: 'test'
  ...
# Subtest: SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
ok 244 - SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
  ---
  duration_ms: 0.85005
  type: 'test'
  ...
# Subtest: IDEM-01: dispatchFinancialCommand passes operationId through args
ok 245 - IDEM-01: dispatchFinancialCommand passes operationId through args
  ---
  duration_ms: 0.572479
  type: 'test'
  ...
1..245
# tests 245
# suites 0
# pass 244
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1951.275734
```

## lint
```text

> masrofi-ai@6.0.0 lint
> tsc --noEmit

src/App.tsx(1367,13): error TS2552: Cannot find name 'fetchVaultData'. Did you mean 'setVaultData'?
```

## build
```text
not run
```

