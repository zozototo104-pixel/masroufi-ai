# CI Verification Report

Source commit: a263221b9da9f540b6aca6c6ccaeeb3c3bc6aa8b
Run: 33377472642
Install: success
Tests: failure
TypeScript: success
Build: success

## install
```text
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me

added 543 packages, and audited 544 packages in 13s

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
  duration_ms: 1.03431
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-03: transferMoney has NO direct write fallback
ok 131 - TRANSFER-CONC-03: transferMoney has NO direct write fallback
  ---
  duration_ms: 3.492599
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
ok 132 - OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
  ---
  duration_ms: 1.538675
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
ok 133 - OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
  ---
  duration_ms: 1.2321
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
ok 134 - OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
  ---
  duration_ms: 2.529273
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
ok 135 - OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
  ---
  duration_ms: 1.729102
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
ok 136 - OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
  ---
  duration_ms: 2.108614
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
ok 137 - UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
  ---
  duration_ms: 1.837366
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
ok 138 - UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
  ---
  duration_ms: 3.133576
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
ok 139 - UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
  ---
  duration_ms: 2.22383
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
ok 140 - UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
  ---
  duration_ms: 2.290945
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-01: addTransaction rejects on partial snapshot
ok 141 - PARTIAL-STATE-01: addTransaction rejects on partial snapshot
  ---
  duration_ms: 2.322144
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-02: transferMoney rejects on partial balance
ok 142 - PARTIAL-STATE-02: transferMoney rejects on partial balance
  ---
  duration_ms: 1.953253
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-03: payDebt rejects on partial snapshot
ok 143 - PARTIAL-STATE-03: payDebt rejects on partial snapshot
  ---
  duration_ms: 1.809984
  type: 'test'
  ...
# Subtest: FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
ok 144 - FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
  ---
  duration_ms: 0.890811
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
ok 145 - STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
  ---
  duration_ms: 2.349115
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
ok 146 - STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
  ---
  duration_ms: 4.057007
  type: 'test'
  ...
# Subtest: SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
ok 147 - SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
  ---
  duration_ms: 1.393763
  type: 'test'
  ...
# Subtest: IDEM-01: dispatchFinancialCommand passes operationId through args
ok 148 - IDEM-01: dispatchFinancialCommand passes operationId through args
  ---
  duration_ms: 1.125541
  type: 'test'
  ...
1..148
# tests 148
# suites 0
# pass 140
# fail 8
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1721.063974
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
[32m✓ built in 5.08s[39m

  dist/server.cjs      465.2kb
  dist/server.cjs.map  725.7kb

⚡ Done in 23ms
```

