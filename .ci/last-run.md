# CI Verification Report

Source commit: 4591e636a66bc4e3fccce21a0565feed7046b527
Run: 33376427111
Install: success
Tests: success
TypeScript: success
Build: success

## install
```text
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@supabase/auth-js@2.112.3',
npm warn EBADENGINE   required: { node: '>=22.0.0' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@supabase/realtime-js@2.112.3',
npm warn EBADENGINE   required: { node: '>=22.0.0' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@supabase/storage-js@2.112.3',
npm warn EBADENGINE   required: { node: '>=22.0.0' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@supabase/supabase-js@2.112.3',
npm warn EBADENGINE   required: { node: '>=22.0.0' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@supabase/functions-js@2.112.3',
npm warn EBADENGINE   required: { node: '>=22.0.0' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: '@supabase/postgrest-js@2.112.3',
npm warn EBADENGINE   required: { node: '>=22.0.0' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn EBADENGINE Unsupported engine {
npm warn EBADENGINE   package: 'firebase-admin@14.3.0',
npm warn EBADENGINE   required: { node: '>=22' },
npm warn EBADENGINE   current: { node: 'v20.20.2', npm: '10.8.2' }
npm warn EBADENGINE }
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me

added 542 packages, and audited 543 packages in 13s

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
# Subtest: ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
ok 127 - ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
  ---
  duration_ms: 6.689432
  ...
# Subtest: ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
ok 128 - ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
  ---
  duration_ms: 1.314519
  ...
# Subtest: TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
ok 129 - TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
  ---
  duration_ms: 1.472425
  ...
# Subtest: TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
ok 130 - TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
  ---
  duration_ms: 0.746165
  ...
# Subtest: TRANSFER-CONC-03: transferMoney has NO direct write fallback
ok 131 - TRANSFER-CONC-03: transferMoney has NO direct write fallback
  ---
  duration_ms: 1.473465
  ...
# Subtest: OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
ok 132 - OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
  ---
  duration_ms: 0.7683
  ...
# Subtest: OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
ok 133 - OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
  ---
  duration_ms: 1.917835
  ...
# Subtest: OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
ok 134 - OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
  ---
  duration_ms: 3.662842
  ...
# Subtest: OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
ok 135 - OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
  ---
  duration_ms: 1.746827
  ...
# Subtest: OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
ok 136 - OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
  ---
  duration_ms: 0.888081
  ...
# Subtest: UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
ok 137 - UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
  ---
  duration_ms: 0.594096
  ...
# Subtest: UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
ok 138 - UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
  ---
  duration_ms: 2.223554
  ...
# Subtest: UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
ok 139 - UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
  ---
  duration_ms: 2.127587
  ...
# Subtest: UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
ok 140 - UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
  ---
  duration_ms: 1.777917
  ...
# Subtest: PARTIAL-STATE-01: addTransaction rejects on partial snapshot
ok 141 - PARTIAL-STATE-01: addTransaction rejects on partial snapshot
  ---
  duration_ms: 1.611545
  ...
# Subtest: PARTIAL-STATE-02: transferMoney rejects on partial balance
ok 142 - PARTIAL-STATE-02: transferMoney rejects on partial balance
  ---
  duration_ms: 1.167702
  ...
# Subtest: PARTIAL-STATE-03: payDebt rejects on partial snapshot
ok 143 - PARTIAL-STATE-03: payDebt rejects on partial snapshot
  ---
  duration_ms: 1.107158
  ...
# Subtest: FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
ok 144 - FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
  ---
  duration_ms: 1.016202
  ...
# Subtest: STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
ok 145 - STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
  ---
  duration_ms: 1.44632
  ...
# Subtest: STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
ok 146 - STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
  ---
  duration_ms: 3.64648
  ...
# Subtest: SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
ok 147 - SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
  ---
  duration_ms: 0.550752
  ...
# Subtest: IDEM-01: dispatchFinancialCommand passes operationId through args
ok 148 - IDEM-01: dispatchFinancialCommand passes operationId through args
  ---
  duration_ms: 0.912275
  ...
1..148
# tests 148
# suites 0
# pass 140
# fail 8
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1449.127351
```

## lint
```text

> masrofi-ai@6.0.0 lint
> tsc --noEmit

src/App.tsx(200,30): error TS2339: Property 'user' does not exist on type '{ success: boolean; redirecting?: boolean; error?: string; }'.
src/App.tsx(201,21): error TS2339: Property 'user' does not exist on type '{ success: boolean; redirecting?: boolean; error?: string; }'.
src/App.tsx(202,17): error TS2339: Property 'token' does not exist on type '{ success: boolean; redirecting?: boolean; error?: string; }'.
src/App.tsx(203,26): error TS2339: Property 'token' does not exist on type '{ success: boolean; redirecting?: boolean; error?: string; }'.
src/server/tools.ts(1386,48): error TS2339: Property 'failures' does not exist on type '{ ok: true; entries: PreparedImportedTransaction[]; } | { ok: false; failures: ImportValidationFailure[]; }'.
  Property 'failures' does not exist on type '{ ok: true; entries: PreparedImportedTransaction[]; }'.
src/server/tools.ts(1951,22): error TS2339: Property 'reason' does not exist on type '{ ok: true; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/tools.ts(1952,78): error TS2339: Property 'reason' does not exist on type '{ ok: true; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/tools.ts(1954,22): error TS2339: Property 'reason' does not exist on type '{ ok: true; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/tools.ts(1955,78): error TS2339: Property 'reason' does not exist on type '{ ok: true; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/tools.ts(1957,51): error TS2339: Property 'reason' does not exist on type '{ ok: true; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/tools.ts(1979,26): error TS2339: Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/tools.ts(1979,76): error TS2339: Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/tools.ts(1983,34): error TS2339: Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/tools.ts(1988,55): error TS2339: Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/tools.ts(2049,24): error TS2339: Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/tools.ts(2049,74): error TS2339: Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/tools.ts(2053,32): error TS2339: Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/tools.ts(2058,53): error TS2339: Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; } | { ok: false; reason: string; balances?: any; }'.
  Property 'reason' does not exist on type '{ ok: true; deleted: any; balances: { cash: number; palPay: number; debt: number; total: number; }; }'.
src/server/treasurerEngine.ts(210,3): error TS2862: Type 'T' is generic and can only be indexed for reading.
src/server/treasurerEngine.ts(211,11): error TS2339: Property 'count' does not exist on type 'T'.
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
[2mdist/[22m[2massets/[22m[36mindex-DU4vQXQJ.js   [39m[1m[33m1,045.07 kB[39m[22m[2m │ gzip: 291.36 kB[22m[2m │ map: 5,052.70 kB[22m
[33m
(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.[39m
[32m✓ built in 3.97s[39m

  dist/server.cjs      462.0kb
  dist/server.cjs.map  719.7kb

⚡ Done in 18ms
```

