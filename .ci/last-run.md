# CI Verification Report

Source commit: 73269303d5d52d3df16d2128bf311d28ec922523
Run: 33378197936
Install: success
Tests: failure
TypeScript: success
Build: success

## failing tests
```text
not ok 9 - AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
  ---
  duration_ms: 36.026046
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:1:135'
  failureType: 'testCodeFailure'
  error: 'syncOfflineData must overwrite client userId'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:23:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
# Subtest: AUTHZ-04: deleteReport ownership check exists
ok 10 - AUTHZ-04: deleteReport ownership check exists
  ---
  duration_ms: 12.553625
  type: 'test'
  ...
# Subtest: AUTHZ-05: deleteCommitment ownership check exists
ok 11 - AUTHZ-05: deleteCommitment ownership check exists
  ---
  duration_ms: 4.767679
  type: 'test'
  ...
# Subtest: AUTHZ-06: update_transaction ownership check exists
ok 12 - AUTHZ-06: update_transaction ownership check exists
  ---
  duration_ms: 7.058389
  type: 'test'
  ...
not ok 38 - DUR-03: same operationId returns cached result on retry
  ---
  duration_ms: 5.032772
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:1:1059'
  failureType: 'testCodeFailure'
  error: 'pending state recorded'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:42:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: DUR-04: addTransaction response includes durability + pending flags
ok 39 - DUR-04: addTransaction response includes durability + pending flags
  ---
  duration_ms: 3.661817
  type: 'test'
  ...
# Subtest: DUR-05: getBalance propagates partial flag from FakeDb
ok 40 - DUR-05: getBalance propagates partial flag from FakeDb
  ---
  duration_ms: 2.872616
  type: 'test'
  ...
# Subtest: DUR-06: account switch cannot expose cache — logout clears IndexedDB
ok 41 - DUR-06: account switch cannot expose cache — logout clears IndexedDB
  ---
  duration_ms: 2.229447
  type: 'test'
  ...
not ok 45 - DUR-10: transaction delete cannot report success when cloud durability is pending
  ---
  duration_ms: 4.499358
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:1:4988'
  failureType: 'testCodeFailure'
  error: 'deleteTransaction must fail closed when FakeDb reports pending durability'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:107:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: DUR-11: transaction update refuses balance-sensitive decisions on partial state
ok 46 - DUR-11: transaction update refuses balance-sensitive decisions on partial state
  ---
  duration_ms: 2.389766
  type: 'test'
  ...
# Subtest: DUR-12: restore validates the full financial ledger before replace deletes existing state
ok 47 - DUR-12: restore validates the full financial ledger before replace deletes existing state
  ---
  duration_ms: 2.656192
  type: 'test'
  ...
# Subtest: DUR-13: restore writes only preflighted transactions and checks durability
ok 48 - DUR-13: restore writes only preflighted transactions and checks durability
  ---
  duration_ms: 2.383784
  type: 'test'
  ...
not ok 76 - FIN-14: duplicate operationId executes once — idempotency layer
  ---
  duration_ms: 18.160428
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:5670'
  failureType: 'testCodeFailure'
  error: 'idempotency records pending status'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:174:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: FIN-15: duplicate after restart executes once — persistent idempotency
ok 77 - FIN-15: duplicate after restart executes once — persistent idempotency
  ---
  duration_ms: 11.663475
  type: 'test'
  ...
# Subtest: FIN-16: PalPay malformed amount rejected — sendPalPayPayment guards
ok 78 - FIN-16: PalPay malformed amount rejected — sendPalPayPayment guards
  ---
  duration_ms: 5.146936
  type: 'test'
  ...
# Subtest: FIN-17: NaN rejected — calculateBalancesFromDocs uses Number() with NaN check
ok 79 - FIN-17: NaN rejected — calculateBalancesFromDocs uses Number() with NaN check
  ---
  duration_ms: 0.302183
  type: 'test'
  ...
not ok 93 - PIPE-01: financial writes must not pass through legacy /api/sync raw transaction doc.set
  ---
  duration_ms: 19.861389
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:1:341'
  failureType: 'testCodeFailure'
  error: 'raw transaction doc.set must not exist in sync path'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:13:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async startSubtestAfterBootstrap (node:internal/test_runner/harness:296:3)
  ...
# Subtest: PIPE-02: all mutating financial tools are protected by runIdempotent wrapper
ok 94 - PIPE-02: all mutating financial tools are protected by runIdempotent wrapper
  ---
  duration_ms: 4.42529
  type: 'test'
  ...
# Subtest: PIPE-03: idempotency uses hashed Firestore doc ids and fails closed
not ok 95 - PIPE-03: idempotency uses hashed Firestore doc ids and fails closed
  ---
  duration_ms: 1.899711
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:1:1215'
  failureType: 'testCodeFailure'
  error: 'must not await long polling inside Firestore transaction'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:30:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: PIPE-04: notifications cannot turn a committed financial write into a failure
ok 96 - PIPE-04: notifications cannot turn a committed financial write into a failure
  ---
  duration_ms: 6.513384
  type: 'test'
  ...
# Subtest: PIPE-05: chat financial replies are deterministic from tool results, not model interpretation
ok 97 - PIPE-05: chat financial replies are deterministic from tool results, not model interpretation
  ---
  duration_ms: 2.110515
  type: 'test'
  ...
# Subtest: PIPE-06: offline financial commands go through /api/command only
ok 98 - PIPE-06: offline financial commands go through /api/command only
  ---
  duration_ms: 2.561335
  type: 'test'
  ...
not ok 99 - PIPE-07: income nature must be user-stated, not model-inferred from generated notes
  ---
  duration_ms: 4.13015
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:1:3115'
  failureType: 'testCodeFailure'
  error: 'original user message must be passed into tool validation'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:57:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: MARKET-01: extractPricesFromText parses "3200 ₪"
ok 100 - MARKET-01: extractPricesFromText parses "3200 ₪"
  ---
  duration_ms: 2.229958
  type: 'test'
  ...
# Subtest: MARKET-02: extractPricesFromText handles USD/JOD
ok 101 - MARKET-02: extractPricesFromText handles USD/JOD
  ---
  duration_ms: 0.465418
  type: 'test'
  ...
# Subtest: MARKET-03: isGazaSource detects Gaza/Palestine in title/URL
ok 102 - MARKET-03: isGazaSource detects Gaza/Palestine in title/URL
  ---
  duration_ms: 1.744583
  type: 'test'
  ...
not ok 123 - OFF-05: retry does not duplicate (server-side idempotency)
  ---
  duration_ms: 7.881885
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/offline.test.ts:1:1500'
  failureType: 'testCodeFailure'
  error: 'idempotency records completed status'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/offline.test.ts:41:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: OFF-06: server committed but response lost — retry returns cached result
ok 124 - OFF-06: server committed but response lost — retry returns cached result
  ---
  duration_ms: 6.164643
  type: 'test'
  ...
# Subtest: OFF-06B: offline income parser cannot manufacture server business confirmations
ok 125 - OFF-06B: offline income parser cannot manufacture server business confirmations
  ---
  duration_ms: 4.852467
  type: 'test'
  ...
# Subtest: OFF-07: Login A → logout → Login B cannot see/sync A queue
ok 126 - OFF-07: Login A → logout → Login B cannot see/sync A queue
  ---
  duration_ms: 4.764523
  type: 'test'
  ...
```

## install
```text
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me

added 543 packages, and audited 544 packages in 14s

67 packages are looking for funding
  run `npm fund` for details

6 moderate severity vulnerabilities

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
ok 126 - OFF-07: Login A → logout → Login B cannot see/sync A queue
  ---
  duration_ms: 4.764523
  type: 'test'
  ...
# Subtest: OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
ok 127 - OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
  ---
  duration_ms: 3.954643
  type: 'test'
  ...
# Subtest: OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
ok 128 - OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
  ---
  duration_ms: 1.296417
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
ok 129 - ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
  ---
  duration_ms: 11.877497
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
ok 130 - ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
  ---
  duration_ms: 2.786255
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
ok 131 - TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
  ---
  duration_ms: 2.184353
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
ok 132 - TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
  ---
  duration_ms: 1.210687
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-03: transferMoney has NO direct write fallback
ok 133 - TRANSFER-CONC-03: transferMoney has NO direct write fallback
  ---
  duration_ms: 2.38706
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
ok 134 - OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
  ---
  duration_ms: 1.197502
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
ok 135 - OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
  ---
  duration_ms: 1.087397
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
ok 136 - OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
  ---
  duration_ms: 1.736388
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
ok 137 - OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
  ---
  duration_ms: 1.734183
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
ok 138 - OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
  ---
  duration_ms: 1.870407
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
ok 139 - UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
  ---
  duration_ms: 1.599792
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
ok 140 - UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
  ---
  duration_ms: 4.524966
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
ok 141 - UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
  ---
  duration_ms: 2.344671
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
ok 142 - UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
  ---
  duration_ms: 1.928125
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-01: addTransaction rejects on partial snapshot
ok 143 - PARTIAL-STATE-01: addTransaction rejects on partial snapshot
  ---
  duration_ms: 2.527782
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-02: transferMoney rejects on partial balance
ok 144 - PARTIAL-STATE-02: transferMoney rejects on partial balance
  ---
  duration_ms: 2.484963
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-03: payDebt rejects on partial snapshot
ok 145 - PARTIAL-STATE-03: payDebt rejects on partial snapshot
  ---
  duration_ms: 2.338811
  type: 'test'
  ...
# Subtest: FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
ok 146 - FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
  ---
  duration_ms: 1.165373
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
ok 147 - STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
  ---
  duration_ms: 2.519504
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
ok 148 - STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
  ---
  duration_ms: 6.022288
  type: 'test'
  ...
# Subtest: SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
ok 149 - SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
  ---
  duration_ms: 2.849343
  type: 'test'
  ...
# Subtest: IDEM-01: dispatchFinancialCommand passes operationId through args
ok 150 - IDEM-01: dispatchFinancialCommand passes operationId through args
  ---
  duration_ms: 1.379312
  type: 'test'
  ...
1..150
# tests 150
# suites 0
# pass 142
# fail 8
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2008.031705
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
[32m✓[39m 2671 modules transformed.
rendering chunks...
computing gzip size...
[2mdist/[22m[32mindex.html                 [39m[1m[2m    0.77 kB[22m[1m[22m[2m │ gzip:   0.37 kB[22m
[2mdist/[22m[2massets/[22m[35mindex-D-dThvPl.css  [39m[1m[2m   61.42 kB[22m[1m[22m[2m │ gzip:  10.32 kB[22m
[2mdist/[22m[2massets/[22m[36mindex-CY3nRHNz.js   [39m[1m[33m1,045.03 kB[39m[22m[2m │ gzip: 291.33 kB[22m[2m │ map: 5,052.67 kB[22m
[33m
(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.[39m
[32m✓ built in 5.23s[39m

  dist/server.cjs      468.2kb
  dist/server.cjs.map  730.8kb

⚡ Done in 25ms
```

