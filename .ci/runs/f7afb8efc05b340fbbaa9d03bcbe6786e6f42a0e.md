# CI Verification Report

Source commit: f7afb8efc05b340fbbaa9d03bcbe6786e6f42a0e
Run: 33948101967
Install: success
Tests: failure
TypeScript: success
Build: success
Runtime: success

## failing tests
```text
not ok 27 - CONC-05: concurrent update + expense preserves invariant (NEGATIVE_CASH_RESULT guard)
  ---
  duration_ms: 7.418216
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/concurrency.test.ts:1:2692'
  failureType: 'testCodeFailure'
  error: 'guard triggers when resulting cash is negative'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/concurrency.test.ts:62:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: CONC-06: atomicAddTransaction exists in atomicOps.ts
ok 28 - CONC-06: atomicAddTransaction exists in atomicOps.ts
  ---
  duration_ms: 4.382736
  type: 'test'
  ...
# Subtest: CONC-07: atomicPayDebt recomputes creditor remaining through the shared domain core
not ok 29 - CONC-07: atomicPayDebt recomputes creditor remaining through the shared domain core
  ---
  duration_ms: 1.476624
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/concurrency.test.ts:1:3531'
  failureType: 'testCodeFailure'
  error: 'atomicPayDebt recomputes creditor remaining at transaction time through the shared core'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/concurrency.test.ts:78:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: CONC-08: atomicOps has no circular dependency on tools.ts
ok 30 - CONC-08: atomicOps has no circular dependency on tools.ts
  ---
  duration_ms: 1.448482
  type: 'test'
  ...
# Subtest: CONC-08B: payDebt open-creditor list delegates debt math to the shared domain core
ok 31 - CONC-08B: payDebt open-creditor list delegates debt math to the shared domain core
  ---
  duration_ms: 2.96509
  type: 'test'
  ...
# Subtest: CONC-09: stale pending idempotency keys never auto-reexecute financial mutations
ok 32 - CONC-09: stale pending idempotency keys never auto-reexecute financial mutations
  ---
  duration_ms: 0.716091
  type: 'test'
  ...
not ok 49 - CONC-25: reviewed receipt import records through direct preparation and bounded batch commit
  ---
  duration_ms: 9.591153
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/concurrency.test.ts:1:20887'
  failureType: 'testCodeFailure'
  error: 'full-ledger balance scan skip must be limited to receipt imports with receipt idempotency'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/concurrency.test.ts:366:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: DUR-01: FakeDb.WriteResult exposes durability flag — V6 type definition present
ok 50 - DUR-01: FakeDb.WriteResult exposes durability flag — V6 type definition present
  ---
  duration_ms: 24.114967
  type: 'test'
  ...
# Subtest: DUR-02: idempotency_keys collection persists across restart (Firestore-backed)
ok 51 - DUR-02: idempotency_keys collection persists across restart (Firestore-backed)
  ---
  duration_ms: 4.161484
  type: 'test'
  ...
# Subtest: DUR-03: same operationId returns the completed cached result instead of executing again
ok 52 - DUR-03: same operationId returns the completed cached result instead of executing again
  ---
  duration_ms: 5.003749
  type: 'test'
  ...
not ok 53 - DUR-04: addTransaction response includes durability + pending flags
  ---
  duration_ms: 9.740142
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:1:2061'
  failureType: 'testCodeFailure'
  error: 'addTransaction response must include partial flag'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:61:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: DUR-05: getBalance marks offline-cache fallback as partial
not ok 54 - DUR-05: getBalance marks offline-cache fallback as partial
  ---
  duration_ms: 5.280644
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:1:2571'
  failureType: 'testCodeFailure'
  error: 'getBalance must identify authoritative Firestore reads'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:71:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: DUR-06: account switch cannot expose cache — logout clears IndexedDB
ok 55 - DUR-06: account switch cannot expose cache — logout clears IndexedDB
  ---
  duration_ms: 3.112385
  type: 'test'
  ...
# Subtest: DUR-07: import/export round-trip preserves financial state — HF-5 fix
ok 56 - DUR-07: import/export round-trip preserves financial state — HF-5 fix
  ---
  duration_ms: 1.014064
  type: 'test'
  ...
# Subtest: DUR-08: chat cannot export server-local FakeDb pending operations to legacy client queue
ok 57 - DUR-08: chat cannot export server-local FakeDb pending operations to legacy client queue
  ---
  duration_ms: 5.983581
  type: 'test'
  ...
not ok 60 - DUR-11: transaction update refuses balance-sensitive decisions on partial state
  ---
  duration_ms: 3.309972
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:1:6997'
  failureType: 'testCodeFailure'
  error: 'updateTransaction must refuse partial-state balance computation'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:162:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: DUR-12: restore validates the full backup before replace deletes existing state
ok 61 - DUR-12: restore validates the full backup before replace deletes existing state
  ---
  duration_ms: 3.73386
  type: 'test'
  ...
# Subtest: DUR-13: restore writes only preflighted transactions and checks durability
ok 62 - DUR-13: restore writes only preflighted transactions and checks durability
  ---
  duration_ms: 5.006825
  type: 'test'
  ...
# Subtest: DUR-14: replace restore is one atomic batch and oversized backups fail before mutation
ok 63 - DUR-14: replace restore is one atomic batch and oversized backups fail before mutation
  ---
  duration_ms: 3.010525
  type: 'test'
  ...
```

## install
```text
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me

added 543 packages, and audited 544 packages in 14s

67 packages are looking for funding
  run `npm fund` for details

9 moderate severity vulnerabilities

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
```

## tests
```text
  ...
# Subtest: OFF-07: Login A → logout → Login B cannot see/sync A queue
ok 190 - OFF-07: Login A → logout → Login B cannot see/sync A queue
  ---
  duration_ms: 2.468849
  type: 'test'
  ...
# Subtest: OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
ok 191 - OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
  ---
  duration_ms: 1.706531
  type: 'test'
  ...
# Subtest: OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
ok 192 - OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
  ---
  duration_ms: 1.66782
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
ok 193 - ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
  ---
  duration_ms: 12.5537
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
ok 194 - ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
  ---
  duration_ms: 2.524502
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
ok 195 - TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
  ---
  duration_ms: 1.914866
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
ok 196 - TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
  ---
  duration_ms: 1.153995
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-03: transferMoney has NO direct write fallback
ok 197 - TRANSFER-CONC-03: transferMoney has NO direct write fallback
  ---
  duration_ms: 2.731727
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
ok 198 - OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
  ---
  duration_ms: 1.195342
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
ok 199 - OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
  ---
  duration_ms: 1.189129
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
ok 200 - OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
  ---
  duration_ms: 1.805575
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
ok 201 - OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
  ---
  duration_ms: 1.215138
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
ok 202 - OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
  ---
  duration_ms: 1.533339
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
ok 203 - UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
  ---
  duration_ms: 1.031828
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
ok 204 - UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
  ---
  duration_ms: 2.257355
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
ok 205 - UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
  ---
  duration_ms: 1.545973
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
ok 206 - UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
  ---
  duration_ms: 1.580858
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-01: addTransaction rejects on partial snapshot
ok 207 - PARTIAL-STATE-01: addTransaction rejects on partial snapshot
  ---
  duration_ms: 1.68973
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-02: transferMoney rejects on partial balance
ok 208 - PARTIAL-STATE-02: transferMoney rejects on partial balance
  ---
  duration_ms: 2.681403
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-03: payDebt rejects on partial snapshot
ok 209 - PARTIAL-STATE-03: payDebt rejects on partial snapshot
  ---
  duration_ms: 1.71645
  type: 'test'
  ...
# Subtest: FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
ok 210 - FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
  ---
  duration_ms: 0.8826
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
ok 211 - STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
  ---
  duration_ms: 3.541161
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
ok 212 - STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
  ---
  duration_ms: 2.071199
  type: 'test'
  ...
# Subtest: SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
ok 213 - SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
  ---
  duration_ms: 0.894823
  type: 'test'
  ...
# Subtest: IDEM-01: dispatchFinancialCommand passes operationId through args
ok 214 - IDEM-01: dispatchFinancialCommand passes operationId through args
  ---
  duration_ms: 1.795557
  type: 'test'
  ...
1..214
# tests 214
# suites 0
# pass 208
# fail 6
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2156.085227
```

## lint
```text

> masrofi-ai@6.0.0 lint
> tsc --noEmit

```

## build
```text

> masrofi-ai@6.0.0 build
> vite build && esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs

[36mvite v6.4.3 [32mbuilding for production...[36m[39m
transforming...
[32m✓[39m 2672 modules transformed.
rendering chunks...
computing gzip size...
[2mdist/[22m[32mindex.html                          [39m[1m[2m  1.02 kB[22m[1m[22m[2m │ gzip:   0.43 kB[22m
[2mdist/[22m[2massets/[22m[35mindex-DLrWoCw7.css           [39m[1m[2m 64.03 kB[22m[1m[22m[2m │ gzip:  10.69 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-charts-4uLKkS1u.js    [39m[1m[2m 53.47 kB[22m[1m[22m[2m │ gzip:  18.63 kB[22m[2m │ map:   225.59 kB[22m
[2mdist/[22m[2massets/[22m[36mindex-B3HFFOht.js            [39m[1m[2m187.84 kB[22m[1m[22m[2m │ gzip:  47.42 kB[22m[2m │ map:   463.23 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-firebase-Bxq1IwUx.js  [39m[1m[2m338.23 kB[22m[1m[22m[2m │ gzip:  78.80 kB[22m[2m │ map: 2,305.57 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-COxJT0IA.js           [39m[1m[2m489.09 kB[22m[1m[22m[2m │ gzip: 152.53 kB[22m[2m │ map: 2,114.49 kB[22m
[32m✓ built in 4.97s[39m

  dist/server.cjs       638.4kb
  dist/server.cjs.map  1010.4kb

⚡ Done in 30ms
```

