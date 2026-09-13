# CI Verification Report

Source commit: 988cfa2cdfd2815ed0aded4ccceb9753bd2a4985
Run: 34787231691
Install: success
Tests: failure
TypeScript: failure
Build: success
Runtime: success
Audit: success

## failing tests
```text
not ok 7 - AUTH-07: server cannot mint a Firebase identity from an email claim
  ---
  duration_ms: 24.197814
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/auth.test.ts:1:2207'
  failureType: 'testCodeFailure'
  error: 'Safari/mobile must use Firebase provider-controlled redirect authentication'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/auth.test.ts:106:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: WS-01: token not in WebSocket URL — verified via source inspection
ok 8 - WS-01: token not in WebSocket URL — verified via source inspection
  ---
  duration_ms: 4.547587
  type: 'test'
  ...
# Subtest: AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
ok 9 - AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
  ---
  duration_ms: 22.716611
  type: 'test'
  ...
# Subtest: AUTHZ-04: deleteReport ownership check exists
ok 10 - AUTHZ-04: deleteReport ownership check exists
  ---
  duration_ms: 5.246899
  type: 'test'
  ...
not ok 15 - TOOL-02/03: addTransaction debt guard present (HF-7)
  ---
  duration_ms: 8.01579
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:1:3394'
  failureType: 'testCodeFailure'
  error: 'debt guard triggers when ratio > 1.0 OR amount > 5000'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:88:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: TOOL-04: ambiguous creditor asks clarification (payDebt)
ok 16 - TOOL-04: ambiguous creditor asks clarification (payDebt)
  ---
  duration_ms: 1.409379
  type: 'test'
  ...
# Subtest: TOOL-05: smart delete asks confirmation even with single match (MF-6)
ok 17 - TOOL-05: smart delete asks confirmation even with single match (MF-6)
  ---
  duration_ms: 7.342094
  type: 'test'
  ...
# Subtest: TOOL-06: memory_search filters by query (MF-2)
ok 18 - TOOL-06: memory_search filters by query (MF-2)
  ---
  duration_ms: 6.201077
  type: 'test'
  ...
not ok 43 - CONC-19: treasurerEngine financial report boundary avoids broad any
  ---
  duration_ms: 6.693361
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/concurrency.test.ts:1:15981'
  failureType: 'testCodeFailure'
  error: |-
    treasurerEngine must use explicit local types or unknown at input boundaries instead of broad any
    
    true !== false
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: false
  actual: true
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/concurrency.test.ts:258:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: CONC-20: tools financial amounts use the shared finite amount parser
ok 44 - CONC-20: tools financial amounts use the shared finite amount parser
  ---
  duration_ms: 6.954623
  type: 'test'
  ...
# Subtest: CONC-21: atomic financial guards parse amounts through the shared finite parser
ok 45 - CONC-21: atomic financial guards parse amounts through the shared finite parser
  ---
  duration_ms: 0.635379
  type: 'test'
  ...
# Subtest: CONC-22: savings contributions use Firestore transaction and contribution history
ok 46 - CONC-22: savings contributions use Firestore transaction and contribution history
not ok 60 - DUR-11: transaction update refuses balance-sensitive decisions on partial state
  ---
  duration_ms: 20.376155
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:1:7056'
  failureType: 'testCodeFailure'
  error: 'updateTransaction must use atomic snapshot balance updates and fail closed on uncertain bounded budget reads'
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
  duration_ms: 11.472568
  type: 'test'
  ...
# Subtest: DUR-13: restore writes only preflighted transactions and checks durability
ok 62 - DUR-13: restore writes only preflighted transactions and checks durability
  ---
  duration_ms: 5.93237
  type: 'test'
  ...
# Subtest: DUR-14: replace restore is one atomic batch and oversized backups fail before mutation
ok 63 - DUR-14: replace restore is one atomic batch and oversized backups fail before mutation
  ---
  duration_ms: 7.709918
  type: 'test'
  ...
not ok 123 - DOMAIN-03B: credit purchases accept creditor alias and do not require cash preflight
  ---
  duration_ms: 23.875504
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:24585'
  failureType: 'testCodeFailure'
  error: 'addTransaction must identify credit purchases before cash/PalPay preflight'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:562:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: DOMAIN-03B2: salary cycle details expose credit purchases under a debt bucket
ok 124 - DOMAIN-03B2: salary cycle details expose credit purchases under a debt bucket
  ---
  duration_ms: 16.824162
  type: 'test'
  ...
# Subtest: DOMAIN-03C: credit purchase changes debt only, not liquid balances
ok 125 - DOMAIN-03C: credit purchase changes debt only, not liquid balances
  ---
  duration_ms: 0.342331
  type: 'test'
  ...
# Subtest: DOMAIN-03D: salary-cycle details expose cash trace so missing cash can be audited
ok 126 - DOMAIN-03D: salary-cycle details expose cash trace so missing cash can be audited
  ---
  duration_ms: 26.823739
  type: 'test'
  ...
not ok 141 - VAULT-07: salary cycle query is bounded by start/end dates and never a full ledger scan
  ---
  duration_ms: 16.390814
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:41489'
  failureType: 'testCodeFailure'
  error: 'cycle query must lower-bound date'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:822:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: VAULT-08: recalculating the same cycle is idempotent through one salaryCycles doc
ok 142 - VAULT-08: recalculating the same cycle is idempotent through one salaryCycles doc
  ---
  duration_ms: 9.598624
  type: 'test'
  ...
# Subtest: VAULT-09: old transaction edits recalculate only affected cycles
ok 143 - VAULT-09: old transaction edits recalculate only affected cycles
  ---
  duration_ms: 6.783988
  type: 'test'
  ...
# Subtest: VAULT-10: voice month questions and explicit date ranges have separate contracts
ok 144 - VAULT-10: voice month questions and explicit date ranges have separate contracts
  ---
  duration_ms: 8.390683
  type: 'test'
  ...
not ok 171 - DELETE-DATE-01: smart delete can find exact-date cash tracking rows outside recent createdAt window
  ---
  duration_ms: 10.042533
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:88907'
  failureType: 'testCodeFailure'
  error: 'smart delete must query the exact transaction date instead of only recent createdAt rows'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1228:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: DEBT-REPORT-01: salary-cycle debt questions include repayments made after the cycle
ok 172 - DEBT-REPORT-01: salary-cycle debt questions include repayments made after the cycle
  ---
  duration_ms: 9.345718
  type: 'test'
  ...
# Subtest: MOBILE-01: large app modals are iPhone-safe and scrollable
ok 173 - MOBILE-01: large app modals are iPhone-safe and scrollable
  ---
  duration_ms: 5.736689
  type: 'test'
  ...
# Subtest: VAULT-CURRENCY-01: manual vault carryover preserves original ILS/USD/EUR amounts separately
ok 174 - VAULT-CURRENCY-01: manual vault carryover preserves original ILS/USD/EUR amounts separately
  ---
  duration_ms: 0.446012
  type: 'test'
  ...
not ok 177 - LIVE-01: voice path prevents duplicate expert playback and echo feedback loops
  ---
  duration_ms: 4.593364
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:115691'
  failureType: 'testCodeFailure'
  error: 'barge-in threshold must resist speaker echo false positives'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1342:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: LIVE-02: Gemini Live quota exhaustion is classified and surfaced to the user
not ok 178 - LIVE-02: Gemini Live quota exhaustion is classified and surfaced to the user
  ---
  duration_ms: 7.879032
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:119469'
  failureType: 'testCodeFailure'
  error: 'client must boost quiet Gemini Live playback loudly through one persistent compressed output chain without changing microphone input and must clean up audio nodes'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1375:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: REPORTS-06: Treasurer/monthly expense analysis must not refuse or misroute to today reads
ok 179 - REPORTS-06: Treasurer/monthly expense analysis must not refuse or misroute to today reads
  ---
  duration_ms: 12.02173
  type: 'test'
  ...
# Subtest: CLARIFICATION-03: payment/account clarification must complete the original financial operation without repeating questions
ok 180 - CLARIFICATION-03: payment/account clarification must complete the original financial operation without repeating questions
  ---
  duration_ms: 8.072243
  type: 'test'
  ...
# Subtest: CYCLES-UI-01: Savings Vault exposes salary-cycle navigation details and bounded delete
not ok 181 - CYCLES-UI-01: Savings Vault exposes salary-cycle navigation details and bounded delete
  ---
  duration_ms: 9.918062
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:131935'
  failureType: 'testCodeFailure'
  error: 'cycle query must remain bounded to the selected 27→26 date range'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1441:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: PIPE-01: financial writes must not pass through legacy /api/sync raw transaction doc.set
ok 182 - PIPE-01: financial writes must not pass through legacy /api/sync raw transaction doc.set
  ---
  duration_ms: 18.518132
  type: 'test'
  ...
# Subtest: PIPE-02: all mutating financial tools are protected by runIdempotent wrapper
ok 183 - PIPE-02: all mutating financial tools are protected by runIdempotent wrapper
  ---
  duration_ms: 17.82434
  type: 'test'
  ...
# Subtest: PIPE-03: idempotency uses hashed Firestore doc ids and fails closed
not ok 184 - PIPE-03: idempotency uses hashed Firestore doc ids and fails closed
  ---
  duration_ms: 12.791222
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:1:1913'
  failureType: 'testCodeFailure'
  error: 'pending duplicates may wait only after the claim transaction has completed'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:43:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: PIPE-04: notifications cannot turn a committed financial write into a failure
ok 185 - PIPE-04: notifications cannot turn a committed financial write into a failure
  ---
  duration_ms: 13.041381
  type: 'test'
  ...
# Subtest: PIPE-05: chat financial replies are deterministic from tool results, not model interpretation
ok 186 - PIPE-05: chat financial replies are deterministic from tool results, not model interpretation
  ---
  duration_ms: 10.56209
  type: 'test'
  ...
# Subtest: PIPE-06: offline financial commands go through /api/command only
ok 187 - PIPE-06: offline financial commands go through /api/command only
  ---
  duration_ms: 7.508567
  type: 'test'
  ...
not ok 194 - VOICE-06: mobile barge-in resists speaker echo false positives
  ---
  duration_ms: 1.402389
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:1:7858'
  failureType: 'testCodeFailure'
  error: 'barge-in must use a higher speech threshold to avoid echo-triggered cuts'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:120:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: VOICE-07: websocket connect reads the latest selected voice
ok 195 - VOICE-07: websocket connect reads the latest selected voice
  ---
  duration_ms: 2.499514
  type: 'test'
  ...
# Subtest: VOICE-08: dormant personal-voice management remains isolated from Live voice runtime
ok 196 - VOICE-08: dormant personal-voice management remains isolated from Live voice runtime
  ---
  duration_ms: 8.003583
  type: 'test'
  ...
# Subtest: FIN-LIVE-01: duplicate in-flight Live write prefers a confirmed committed result
ok 197 - FIN-LIVE-01: duplicate in-flight Live write prefers a confirmed committed result
  ---
  duration_ms: 5.268042
  type: 'test'
  ...
```

## not-ok context
```text
32-ok 5 - AUTH-05: malformed Bearer (no token after prefix) rejected
33-  ---
34-  duration_ms: 0.138553
35-  type: 'test'
36-  ...
37-# Subtest: AUTH-06: token with empty uid rejected
38-ok 6 - AUTH-06: token with empty uid rejected
39-  ---
40-  duration_ms: 0.154747
41-  type: 'test'
42-  ...
43-# Subtest: AUTH-07: server cannot mint a Firebase identity from an email claim
44:not ok 7 - AUTH-07: server cannot mint a Firebase identity from an email claim
45-  ---
46-  duration_ms: 24.197814
47-  type: 'test'
48-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/auth.test.ts:1:2207'
49-  failureType: 'testCodeFailure'
50:  error: 'Safari/mobile must use Firebase provider-controlled redirect authentication'
51:  code: 'ERR_ASSERTION'
52:  name: 'AssertionError'
53-  expected: true
54-  actual: false
55-  operator: '=='
56-  stack: |-
57-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/auth.test.ts:106:10)
58-    async Test.run (node:internal/test_runner/test:1054:7)
59-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
60-  ...
61-# Subtest: WS-01: token not in WebSocket URL — verified via source inspection
62-ok 8 - WS-01: token not in WebSocket URL — verified via source inspection
63-  ---
64-  duration_ms: 4.547587
--
92-ok 13 - FIRESTORE-RULES-01: rules file is not empty (CF-7)
93-  ---
94-  duration_ms: 1.495855
95-  type: 'test'
96-  ...
97-# Subtest: TOOL-01: search_market_information declaration REMOVED (HF-1)
98-ok 14 - TOOL-01: search_market_information declaration REMOVED (HF-1)
99-  ---
100-  duration_ms: 7.156983
101-  type: 'test'
102-  ...
103-# Subtest: TOOL-02/03: addTransaction debt guard present (HF-7)
104:not ok 15 - TOOL-02/03: addTransaction debt guard present (HF-7)
105-  ---
106-  duration_ms: 8.01579
107-  type: 'test'
108-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:1:3394'
109-  failureType: 'testCodeFailure'
110:  error: 'debt guard triggers when ratio > 1.0 OR amount > 5000'
111:  code: 'ERR_ASSERTION'
112:  name: 'AssertionError'
113-  expected: true
114-  actual: false
115-  operator: '=='
116-  stack: |-
117-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:88:10)
118-    async Test.run (node:internal/test_runner/test:1054:7)
119-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
120-  ...
121-# Subtest: TOOL-04: ambiguous creditor asks clarification (payDebt)
122-ok 16 - TOOL-04: ambiguous creditor asks clarification (payDebt)
123-  ---
124-  duration_ms: 1.409379
--
272-ok 41 - CONC-17: tools.ts reuses canonical account normalization instead of duplicating ledger rules
273-  ---
274-  duration_ms: 5.304505
275-  type: 'test'
276-  ...
277-# Subtest: CONC-18: disabled legacy import writer code is not retained as source text
278-ok 42 - CONC-18: disabled legacy import writer code is not retained as source text
279-  ---
280-  duration_ms: 13.983513
281-  type: 'test'
282-  ...
283-# Subtest: CONC-19: treasurerEngine financial report boundary avoids broad any
284:not ok 43 - CONC-19: treasurerEngine financial report boundary avoids broad any
285-  ---
286-  duration_ms: 6.693361
287-  type: 'test'
288-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/concurrency.test.ts:1:15981'
289-  failureType: 'testCodeFailure'
290:  error: |-
291-    treasurerEngine must use explicit local types or unknown at input boundaries instead of broad any
292-    
293-    true !== false
294-    
295:  code: 'ERR_ASSERTION'
296:  name: 'AssertionError'
297-  expected: false
298-  actual: true
299-  operator: 'strictEqual'
300-  stack: |-
301-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/concurrency.test.ts:258:10)
302-    async Test.run (node:internal/test_runner/test:1054:7)
303-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
304-  ...
305-# Subtest: CONC-20: tools financial amounts use the shared finite amount parser
306-ok 44 - CONC-20: tools financial amounts use the shared finite amount parser
307-  ---
308-  duration_ms: 6.954623
--
390-ok 58 - DUR-09: legacy pending financial documents are quarantined, never guessed as ADD_TRANSACTION
391-  ---
392-  duration_ms: 1.243058
393-  type: 'test'
394-  ...
395-# Subtest: DUR-10: transaction delete is durability-safe through atomic Firestore deletion
396-ok 59 - DUR-10: transaction delete is durability-safe through atomic Firestore deletion
397-  ---
398-  duration_ms: 5.435286
399-  type: 'test'
400-  ...
401-# Subtest: DUR-11: transaction update refuses balance-sensitive decisions on partial state
402:not ok 60 - DUR-11: transaction update refuses balance-sensitive decisions on partial state
403-  ---
404-  duration_ms: 20.376155
405-  type: 'test'
406-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:1:7056'
407-  failureType: 'testCodeFailure'
408:  error: 'updateTransaction must use atomic snapshot balance updates and fail closed on uncertain bounded budget reads'
409:  code: 'ERR_ASSERTION'
410:  name: 'AssertionError'
411-  expected: true
412-  actual: false
413-  operator: '=='
414-  stack: |-
415-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:162:10)
416-    async Test.run (node:internal/test_runner/test:1054:7)
417-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
418-  ...
419-# Subtest: DUR-12: restore validates the full backup before replace deletes existing state
420-ok 61 - DUR-12: restore validates the full backup before replace deletes existing state
421-  ---
422-  duration_ms: 11.472568
--
780-ok 121 - DOMAIN-02: creditor identity normalization collapses Arabic spelling/diacritic variants
781-  ---
782-  duration_ms: 0.112414
783-  type: 'test'
784-  ...
785-# Subtest: DOMAIN-03: creditor remaining is reconstructed behaviorally from purchases and repayments
786-ok 122 - DOMAIN-03: creditor remaining is reconstructed behaviorally from purchases and repayments
787-  ---
788-  duration_ms: 0.387793
789-  type: 'test'
790-  ...
791-# Subtest: DOMAIN-03B: credit purchases accept creditor alias and do not require cash preflight
792:not ok 123 - DOMAIN-03B: credit purchases accept creditor alias and do not require cash preflight
793-  ---
794-  duration_ms: 23.875504
795-  type: 'test'
796-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:24585'
797-  failureType: 'testCodeFailure'
798:  error: 'addTransaction must identify credit purchases before cash/PalPay preflight'
799:  code: 'ERR_ASSERTION'
800:  name: 'AssertionError'
801-  expected: true
802-  actual: false
803-  operator: '=='
804-  stack: |-
805-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:562:10)
806-    async Test.run (node:internal/test_runner/test:1054:7)
807-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
808-  ...
809-# Subtest: DOMAIN-03B2: salary cycle details expose credit purchases under a debt bucket
810-ok 124 - DOMAIN-03B2: salary cycle details expose credit purchases under a debt bucket
811-  ---
812-  duration_ms: 16.824162
--
900-ok 139 - VAULT-05: positive, zero, and deficit cycle surplus behavior is explicit
901-  ---
902-  duration_ms: 0.561059
903-  type: 'test'
904-  ...
905-# Subtest: VAULT-06: Arabic month 7 resolves as salary cycle July, not calendar July
906-ok 140 - VAULT-06: Arabic month 7 resolves as salary cycle July, not calendar July
907-  ---
908-  duration_ms: 0.503725
909-  type: 'test'
910-  ...
911-# Subtest: VAULT-07: salary cycle query is bounded by start/end dates and never a full ledger scan
912:not ok 141 - VAULT-07: salary cycle query is bounded by start/end dates and never a full ledger scan
913-  ---
914-  duration_ms: 16.390814
915-  type: 'test'
916-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:41489'
917-  failureType: 'testCodeFailure'
918:  error: 'cycle query must lower-bound date'
919:  code: 'ERR_ASSERTION'
920:  name: 'AssertionError'
921-  expected: true
922-  actual: false
923-  operator: '=='
924-  stack: |-
925-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:822:10)
926-    async Test.run (node:internal/test_runner/test:1054:7)
927-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
928-  ...
929-# Subtest: VAULT-08: recalculating the same cycle is idempotent through one salaryCycles doc
930-ok 142 - VAULT-08: recalculating the same cycle is idempotent through one salaryCycles doc
931-  ---
932-  duration_ms: 9.598624
--
1092-ok 169 - IMPORT-02: receipt record uses server balances and splits cash to PalPay before debt
1093-  ---
1094-  duration_ms: 4.26406
1095-  type: 'test'
1096-  ...
1097-# Subtest: DELETE-RECENT-01: voice can safely delete last N expenses or last debt payment without full ledger scan
1098-ok 170 - DELETE-RECENT-01: voice can safely delete last N expenses or last debt payment without full ledger scan
1099-  ---
1100-  duration_ms: 11.571051
1101-  type: 'test'
1102-  ...
1103-# Subtest: DELETE-DATE-01: smart delete can find exact-date cash tracking rows outside recent createdAt window
1104:not ok 171 - DELETE-DATE-01: smart delete can find exact-date cash tracking rows outside recent createdAt window
1105-  ---
1106-  duration_ms: 10.042533
1107-  type: 'test'
1108-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:88907'
1109-  failureType: 'testCodeFailure'
1110:  error: 'smart delete must query the exact transaction date instead of only recent createdAt rows'
1111:  code: 'ERR_ASSERTION'
1112:  name: 'AssertionError'
1113-  expected: true
1114-  actual: false
1115-  operator: '=='
1116-  stack: |-
1117-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1228:10)
1118-    async Test.run (node:internal/test_runner/test:1054:7)
1119-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1120-  ...
1121-# Subtest: DEBT-REPORT-01: salary-cycle debt questions include repayments made after the cycle
1122-ok 172 - DEBT-REPORT-01: salary-cycle debt questions include repayments made after the cycle
1123-  ---
1124-  duration_ms: 9.345718
--
1140-ok 175 - VAULT-CURRENCY-02: currency deltas can be repaired from old and new vault adjustment shapes
1141-  ---
1142-  duration_ms: 0.365981
1143-  type: 'test'
1144-  ...
1145-# Subtest: VAULT-CURRENCY-03: tools and UI expose multi-currency vault fields without touching cash/PalPay/debt
1146-ok 176 - VAULT-CURRENCY-03: tools and UI expose multi-currency vault fields without touching cash/PalPay/debt
1147-  ---
1148-  duration_ms: 11.776122
1149-  type: 'test'
1150-  ...
1151-# Subtest: LIVE-01: voice path prevents duplicate expert playback and echo feedback loops
1152:not ok 177 - LIVE-01: voice path prevents duplicate expert playback and echo feedback loops
1153-  ---
1154-  duration_ms: 4.593364
1155-  type: 'test'
1156-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:115691'
1157-  failureType: 'testCodeFailure'
1158:  error: 'barge-in threshold must resist speaker echo false positives'
1159:  code: 'ERR_ASSERTION'
1160:  name: 'AssertionError'
1161-  expected: true
1162-  actual: false
1163-  operator: '=='
1164-  stack: |-
1165-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1342:10)
1166-    async Test.run (node:internal/test_runner/test:1054:7)
1167-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1168-  ...
1169-# Subtest: LIVE-02: Gemini Live quota exhaustion is classified and surfaced to the user
1170:not ok 178 - LIVE-02: Gemini Live quota exhaustion is classified and surfaced to the user
1171-  ---
1172-  duration_ms: 7.879032
1173-  type: 'test'
1174-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:119469'
1175-  failureType: 'testCodeFailure'
1176:  error: 'client must boost quiet Gemini Live playback loudly through one persistent compressed output chain without changing microphone input and must clean up audio nodes'
1177:  code: 'ERR_ASSERTION'
1178:  name: 'AssertionError'
1179-  expected: true
1180-  actual: false
1181-  operator: '=='
1182-  stack: |-
1183-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1375:10)
1184-    async Test.run (node:internal/test_runner/test:1054:7)
1185-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1186-  ...
1187-# Subtest: REPORTS-06: Treasurer/monthly expense analysis must not refuse or misroute to today reads
1188-ok 179 - REPORTS-06: Treasurer/monthly expense analysis must not refuse or misroute to today reads
1189-  ---
1190-  duration_ms: 12.02173
1191-  type: 'test'
1192-  ...
1193-# Subtest: CLARIFICATION-03: payment/account clarification must complete the original financial operation without repeating questions
1194-ok 180 - CLARIFICATION-03: payment/account clarification must complete the original financial operation without repeating questions
1195-  ---
1196-  duration_ms: 8.072243
1197-  type: 'test'
1198-  ...
1199-# Subtest: CYCLES-UI-01: Savings Vault exposes salary-cycle navigation details and bounded delete
1200:not ok 181 - CYCLES-UI-01: Savings Vault exposes salary-cycle navigation details and bounded delete
1201-  ---
1202-  duration_ms: 9.918062
1203-  type: 'test'
1204-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:131935'
1205-  failureType: 'testCodeFailure'
1206:  error: 'cycle query must remain bounded to the selected 27→26 date range'
1207:  code: 'ERR_ASSERTION'
1208:  name: 'AssertionError'
1209-  expected: true
1210-  actual: false
1211-  operator: '=='
1212-  stack: |-
1213-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1441:10)
1214-    async Test.run (node:internal/test_runner/test:1054:7)
1215-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1216-  ...
1217-# Subtest: PIPE-01: financial writes must not pass through legacy /api/sync raw transaction doc.set
1218-ok 182 - PIPE-01: financial writes must not pass through legacy /api/sync raw transaction doc.set
1219-  ---
1220-  duration_ms: 18.518132
1221-  type: 'test'
1222-  ...
1223-# Subtest: PIPE-02: all mutating financial tools are protected by runIdempotent wrapper
1224-ok 183 - PIPE-02: all mutating financial tools are protected by runIdempotent wrapper
1225-  ---
1226-  duration_ms: 17.82434
1227-  type: 'test'
1228-  ...
1229-# Subtest: PIPE-03: idempotency uses hashed Firestore doc ids and fails closed
1230:not ok 184 - PIPE-03: idempotency uses hashed Firestore doc ids and fails closed
1231-  ---
1232-  duration_ms: 12.791222
1233-  type: 'test'
1234-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:1:1913'
1235-  failureType: 'testCodeFailure'
1236:  error: 'pending duplicates may wait only after the claim transaction has completed'
1237:  code: 'ERR_ASSERTION'
1238:  name: 'AssertionError'
1239-  expected: true
1240-  actual: false
1241-  operator: '=='
1242-  stack: |-
1243-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:43:10)
1244-    async Test.run (node:internal/test_runner/test:1054:7)
1245-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1246-  ...
1247-# Subtest: PIPE-04: notifications cannot turn a committed financial write into a failure
1248-ok 185 - PIPE-04: notifications cannot turn a committed financial write into a failure
1249-  ---
1250-  duration_ms: 13.041381
--
1290-ok 192 - VOICE-04: Gemini Live forwards native audio without personal-voice interception
1291-  ---
1292-  duration_ms: 2.846442
1293-  type: 'test'
1294-  ...
1295-# Subtest: VOICE-05: interruption handling matches the original Gemini Live path
1296-ok 193 - VOICE-05: interruption handling matches the original Gemini Live path
1297-  ---
1298-  duration_ms: 5.496105
1299-  type: 'test'
1300-  ...
1301-# Subtest: VOICE-06: mobile barge-in resists speaker echo false positives
1302:not ok 194 - VOICE-06: mobile barge-in resists speaker echo false positives
1303-  ---
1304-  duration_ms: 1.402389
1305-  type: 'test'
1306-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:1:7858'
1307-  failureType: 'testCodeFailure'
1308:  error: 'barge-in must use a higher speech threshold to avoid echo-triggered cuts'
1309:  code: 'ERR_ASSERTION'
1310:  name: 'AssertionError'
1311-  expected: true
1312-  actual: false
1313-  operator: '=='
1314-  stack: |-
1315-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:120:10)
1316-    async Test.run (node:internal/test_runner/test:1054:7)
1317-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1318-  ...
1319-# Subtest: VOICE-07: websocket connect reads the latest selected voice
1320-ok 195 - VOICE-07: websocket connect reads the latest selected voice
1321-  ---
1322-  duration_ms: 2.499514
```

## install
```text
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me

added 543 packages, and audited 544 packages in 12s

67 packages are looking for funding
  run `npm fund` for details

found 0 vulnerabilities
```

## audit
```text
found 0 vulnerabilities
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
  duration_ms: 1.199507
  type: 'test'
  ...
# Subtest: AUTH-02: missing Authorization header rejected
ok 2 - AUTH-02: missing Authorization header rejected
  ---
  duration_ms: 0.19338
  type: 'test'
  ...
# Subtest: AUTH-03: no default-user fallback — invalid token stays 401
ok 3 - AUTH-03: no default-user fallback — invalid token stays 401
  ---
  duration_ms: 0.274058
  type: 'test'
  ...
# Subtest: AUTH-04: valid Firebase ID token accepted
ok 4 - AUTH-04: valid Firebase ID token accepted
  ---
  duration_ms: 0.152935
  type: 'test'
  ...
# Subtest: AUTH-05: malformed Bearer (no token after prefix) rejected
ok 5 - AUTH-05: malformed Bearer (no token after prefix) rejected
  ---
  duration_ms: 0.138553
  type: 'test'
  ...
# Subtest: AUTH-06: token with empty uid rejected
ok 6 - AUTH-06: token with empty uid rejected
  ---
  duration_ms: 0.154747
  type: 'test'
  ...
# Subtest: AUTH-07: server cannot mint a Firebase identity from an email claim
not ok 7 - AUTH-07: server cannot mint a Firebase identity from an email claim
  ---
  duration_ms: 24.197814
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/auth.test.ts:1:2207'
  failureType: 'testCodeFailure'
  error: 'Safari/mobile must use Firebase provider-controlled redirect authentication'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/auth.test.ts:106:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: WS-01: token not in WebSocket URL — verified via source inspection
ok 8 - WS-01: token not in WebSocket URL — verified via source inspection
  ---
  duration_ms: 4.547587
  type: 'test'
  ...
# Subtest: AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
ok 9 - AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
  ---
  duration_ms: 22.716611
  type: 'test'
  ...
# Subtest: AUTHZ-04: deleteReport ownership check exists
ok 10 - AUTHZ-04: deleteReport ownership check exists
  ---
  duration_ms: 5.246899
  type: 'test'
  ...
# Subtest: AUTHZ-05: deleteCommitment ownership check exists
ok 11 - AUTHZ-05: deleteCommitment ownership check exists
  ---
  duration_ms: 11.012274
  type: 'test'
  ...
# Subtest: AUTHZ-06: update_transaction ownership check exists
ok 12 - AUTHZ-06: update_transaction ownership check exists
  ---
  duration_ms: 17.274564
  type: 'test'
  ...
# Subtest: FIRESTORE-RULES-01: rules file is not empty (CF-7)
ok 13 - FIRESTORE-RULES-01: rules file is not empty (CF-7)
  ---
  duration_ms: 1.495855
  type: 'test'
  ...
# Subtest: TOOL-01: search_market_information declaration REMOVED (HF-1)
ok 14 - TOOL-01: search_market_information declaration REMOVED (HF-1)
  ---
  duration_ms: 7.156983
  type: 'test'
  ...
# Subtest: TOOL-02/03: addTransaction debt guard present (HF-7)
not ok 15 - TOOL-02/03: addTransaction debt guard present (HF-7)
  ---
  duration_ms: 8.01579
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:1:3394'
  failureType: 'testCodeFailure'
  error: 'debt guard triggers when ratio > 1.0 OR amount > 5000'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:88:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: TOOL-04: ambiguous creditor asks clarification (payDebt)
ok 16 - TOOL-04: ambiguous creditor asks clarification (payDebt)
  ---
  duration_ms: 1.409379
  type: 'test'
  ...
# Subtest: TOOL-05: smart delete asks confirmation even with single match (MF-6)
ok 17 - TOOL-05: smart delete asks confirmation even with single match (MF-6)
  ---
  duration_ms: 7.342094
  type: 'test'
  ...
# Subtest: TOOL-06: memory_search filters by query (MF-2)
ok 18 - TOOL-06: memory_search filters by query (MF-2)
  ---
  duration_ms: 6.201077
  type: 'test'
  ...
# Subtest: TOOL-07: budget read failure propagates error (HF-6)
ok 19 - TOOL-07: budget read failure propagates error (HF-6)
  ---
  duration_ms: 5.032173
  type: 'test'
  ...
# Subtest: TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)
ok 20 - TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)
  ---
  duration_ms: 5.098548
  type: 'test'
  ...
# Subtest: TOOL-09: commitments support paid/cancelled status (MF-1)
ok 21 - TOOL-09: commitments support paid/cancelled status (MF-1)
  ---
  duration_ms: 8.696629
  type: 'test'
  ...
# Subtest: TOOL-10: sendPalPayPayment validates amount, balance, phone (HF-3)
ok 22 - TOOL-10: sendPalPayPayment validates amount, balance, phone (HF-3)
  ---
  duration_ms: 11.306011
  type: 'test'
  ...
# Subtest: CONC-01: add_transaction commits through Firestore atomic path, not FakeDb pending fallback
ok 23 - CONC-01: add_transaction commits through Firestore atomic path, not FakeDb pending fallback
  ---
  duration_ms: 18.139896
  type: 'test'
  ...
# Subtest: CONC-02: PalPay expense uses atomic guard (same code path)
ok 24 - CONC-02: PalPay expense uses atomic guard (same code path)
  ---
  duration_ms: 5.545758
  type: 'test'
  ...
# Subtest: CONC-03: payDebt uses atomicPayDebt (concurrent payment protection)
ok 25 - CONC-03: payDebt uses atomicPayDebt (concurrent payment protection)
  ---
  duration_ms: 7.733003
  type: 'test'
  ...
# Subtest: CONC-04: same operationId executes once (idempotency layer)
ok 26 - CONC-04: same operationId executes once (idempotency layer)
  ---
  duration_ms: 2.762298
  type: 'test'
  ...
# Subtest: CONC-05: concurrent update + expense preserves invariant (NEGATIVE_CASH_RESULT guard)
ok 27 - CONC-05: concurrent update + expense preserves invariant (NEGATIVE_CASH_RESULT guard)
  ---
  duration_ms: 7.317031
  type: 'test'
  ...
# Subtest: CONC-06: atomicAddTransaction exists in atomicOps.ts
ok 28 - CONC-06: atomicAddTransaction exists in atomicOps.ts
  ---
  duration_ms: 1.872482
  type: 'test'
  ...
# Subtest: CONC-07: atomicPayDebt recomputes creditor remaining through the shared domain core
ok 29 - CONC-07: atomicPayDebt recomputes creditor remaining through the shared domain core
  ---
  duration_ms: 1.095165
  type: 'test'
  ...
# Subtest: CONC-08: atomicOps has no circular dependency on tools.ts
ok 30 - CONC-08: atomicOps has no circular dependency on tools.ts
  ---
  duration_ms: 1.425886
  type: 'test'
  ...
# Subtest: CONC-08B: payDebt open-creditor list delegates debt math to the shared domain core
ok 31 - CONC-08B: payDebt open-creditor list delegates debt math to the shared domain core
  ---
  duration_ms: 15.368723
  type: 'test'
  ...
# Subtest: CONC-09: stale pending idempotency keys never auto-reexecute financial mutations
ok 32 - CONC-09: stale pending idempotency keys never auto-reexecute financial mutations
  ---
  duration_ms: 0.665746
--- tests log tail ---
  ...
# Subtest: MARKET-23: Bank of Israel FX payload parser preserves representative source date
ok 238 - MARKET-23: Bank of Israel FX payload parser preserves representative source date
  ---
  duration_ms: 0.404417
  type: 'test'
  ...
# Subtest: MARKET-24: converted FX market results expose source/date metadata and reject Infinity
ok 239 - MARKET-24: converted FX market results expose source/date metadata and reject Infinity
  ---
  duration_ms: 1.969501
  type: 'test'
  ...
# Subtest: MARKET-25: saved and live market results spread FX metadata when conversion succeeds
ok 240 - MARKET-25: saved and live market results spread FX metadata when conversion succeeds
  ---
  duration_ms: 7.778196
  type: 'test'
  ...
# Subtest: OFF-01: FakeDb.set returns durability=pending on Firestore failure
ok 241 - OFF-01: FakeDb.set returns durability=pending on Firestore failure
  ---
  duration_ms: 9.39492
  type: 'test'
  ...
# Subtest: OFF-02: offline queue persists in IndexedDB (survives browser reload)
ok 242 - OFF-02: offline queue persists in IndexedDB (survives browser reload)
  ---
  duration_ms: 3.834051
  type: 'test'
  ...
# Subtest: OFF-03: queue keyed by userId (survives Cloud Run restart, client-side)
ok 243 - OFF-03: queue keyed by userId (survives Cloud Run restart, client-side)
  ---
  duration_ms: 1.417938
  type: 'test'
  ...
# Subtest: OFF-04: syncPendingOps attempts to sync on fetchData
ok 244 - OFF-04: syncPendingOps attempts to sync on fetchData
  ---
  duration_ms: 2.800996
  type: 'test'
  ...
# Subtest: OFF-05: retry does not duplicate after the operation completed
ok 245 - OFF-05: retry does not duplicate after the operation completed
  ---
  duration_ms: 0.521968
  type: 'test'
  ...
# Subtest: OFF-06: server committed but response lost — retry returns cached result
ok 246 - OFF-06: server committed but response lost — retry returns cached result
  ---
  duration_ms: 0.605259
  type: 'test'
  ...
# Subtest: OFF-06B: offline income parser cannot manufacture server business confirmations
ok 247 - OFF-06B: offline income parser cannot manufacture server business confirmations
  ---
  duration_ms: 4.708616
  type: 'test'
  ...
# Subtest: OFF-07: Login A → logout → Login B cannot see/sync A queue
ok 248 - OFF-07: Login A → logout → Login B cannot see/sync A queue
  ---
  duration_ms: 2.435025
  type: 'test'
  ...
# Subtest: OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
ok 249 - OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
  ---
  duration_ms: 1.227626
  type: 'test'
  ...
# Subtest: OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
ok 250 - OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
  ---
  duration_ms: 1.526229
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
ok 251 - ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
  ---
  duration_ms: 11.658602
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
ok 252 - ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
  ---
  duration_ms: 4.251334
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
ok 253 - TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
  ---
  duration_ms: 4.292832
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
ok 254 - TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
  ---
  duration_ms: 1.019843
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-03: transferMoney has NO direct write fallback
ok 255 - TRANSFER-CONC-03: transferMoney has NO direct write fallback
  ---
  duration_ms: 3.806525
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
ok 256 - OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
  ---
  duration_ms: 0.781868
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
ok 257 - OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
  ---
  duration_ms: 0.690655
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
ok 258 - OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
  ---
  duration_ms: 2.229642
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
ok 259 - OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
  ---
  duration_ms: 1.015459
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
ok 260 - OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
  ---
  duration_ms: 1.082744
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
ok 261 - UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
  ---
  duration_ms: 0.809439
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
ok 262 - UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
  ---
  duration_ms: 0.870661
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
ok 263 - UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
  ---
  duration_ms: 3.686456
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
ok 264 - UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
  ---
  duration_ms: 6.935414
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-01: addTransaction rejects on partial snapshot
ok 265 - PARTIAL-STATE-01: addTransaction rejects on partial snapshot
  ---
  duration_ms: 3.495656
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-02: transferMoney rejects on partial balance
ok 266 - PARTIAL-STATE-02: transferMoney rejects on partial balance
  ---
  duration_ms: 5.925727
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-03: payDebt rejects on partial snapshot
ok 267 - PARTIAL-STATE-03: payDebt rejects on partial snapshot
  ---
  duration_ms: 4.077048
  type: 'test'
  ...
# Subtest: FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
ok 268 - FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
  ---
  duration_ms: 0.611775
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
ok 269 - STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
  ---
  duration_ms: 4.924909
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
ok 270 - STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
  ---
  duration_ms: 7.094922
  type: 'test'
  ...
# Subtest: SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
ok 271 - SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
  ---
  duration_ms: 0.713291
  type: 'test'
  ...
# Subtest: IDEM-01: dispatchFinancialCommand passes operationId through args
ok 272 - IDEM-01: dispatchFinancialCommand passes operationId through args
  ---
  duration_ms: 0.462381
  type: 'test'
  ...
1..272
# tests 272
# suites 0
# pass 260
# fail 12
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2092.177937
```

## lint
```text

> masrofi-ai@6.0.0 lint
> tsc --noEmit

src/App.tsx(196,100): error TS2769: No overload matches this call.
  Overload 1 of 2, '(id: number): void', gave the following error.
    Argument of type 'unknown' is not assignable to parameter of type 'number'.
  Overload 2 of 2, '(timeout: string | number | Timeout): void', gave the following error.
    Argument of type 'unknown' is not assignable to parameter of type 'string | number | Timeout'.
src/server/tools.ts(193,24): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(1161,8): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(1464,200): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(1810,199): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(2185,213): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(2231,23): error TS2339: Property 'id' does not exist on type '{ exists: boolean; data: () => any; partial: boolean; error?: undefined; } | { exists: boolean; data: () => any; partial: boolean; error: any; }'.
  Property 'id' does not exist on type '{ exists: boolean; data: () => any; partial: boolean; error?: undefined; }'.
src/server/tools.ts(2253,8): error TS2554: Expected 2 arguments, but got 3.
src/server/tools.ts(2261,8): error TS2554: Expected 2 arguments, but got 3.
src/server/tools.ts(2287,39): error TS2339: Property 'id' does not exist on type 'SalaryCyclePeriod'.
src/server/tools.ts(2469,205): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(2756,198): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(3122,79): error TS2339: Property 'decision' does not exist on type '{ success: boolean; decision: string; message: string; safeSpending: { currency: any; horizon: { period: string; label: string; startIso: string; endIso: string; daysRemaining: number; salaryCycle: SalaryCyclePeriod; }; ... 11 more ...; cashFlowGap: number; }; ... 7 more ...; readEfficiency: any; } | { ...; }'.
  Property 'decision' does not exist on type '{ success: boolean; message: any; }'.
src/server/tools.ts(3122,108): error TS2339: Property 'safeSpending' does not exist on type '{ success: boolean; decision: string; message: string; safeSpending: { currency: any; horizon: { period: string; label: string; startIso: string; endIso: string; daysRemaining: number; salaryCycle: SalaryCyclePeriod; }; ... 11 more ...; cashFlowGap: number; }; ... 7 more ...; readEfficiency: any; } | { ...; }'.
  Property 'safeSpending' does not exist on type '{ success: boolean; message: any; }'.
src/server/tools.ts(3130,65): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(3211,24): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(3573,5): error TS2322: Type '"" | "cash" | "palPay" | "debt"' is not assignable to type '"cash" | "palPay" | "debt"'.
  Type '""' is not assignable to type '"cash" | "palPay" | "debt"'.
src/server/tools.ts(6278,8): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(8205,44): error TS2554: Expected 1 arguments, but got 2.
```

## build
```text

> masrofi-ai@6.0.0 build
> vite build && esbuild server.ts --bundle --platform=node --format=cjs --packages=external --sourcemap --outfile=dist/server.cjs

[36mvite v6.4.3 [32mbuilding for production...[36m[39m
transforming...
[32m✓[39m 2673 modules transformed.
rendering chunks...
computing gzip size...
[2mdist/[22m[32mindex.html                          [39m[1m[2m  1.02 kB[22m[1m[22m[2m │ gzip:   0.43 kB[22m
[2mdist/[22m[2massets/[22m[35mindex-D2nhgB2V.css           [39m[1m[2m 71.32 kB[22m[1m[22m[2m │ gzip:  11.86 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-charts-D96aqjKe.js    [39m[1m[2m 53.47 kB[22m[1m[22m[2m │ gzip:  18.63 kB[22m[2m │ map:   225.59 kB[22m
[2mdist/[22m[2massets/[22m[36mindex-DHVpyp5Y.js            [39m[1m[2m300.59 kB[22m[1m[22m[2m │ gzip:  70.42 kB[22m[2m │ map:   751.49 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-firebase-ChFgjPjV.js  [39m[1m[2m337.41 kB[22m[1m[22m[2m │ gzip:  78.75 kB[22m[2m │ map: 2,305.04 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-BCsGZLxX.js           [39m[1m[2m489.72 kB[22m[1m[22m[2m │ gzip: 151.90 kB[22m[2m │ map: 2,114.73 kB[22m
[32m✓ built in 4.10s[39m

  dist/server.cjs      1.3mb ⚠️
  dist/server.cjs.map  2.0mb

⚡ Done in 60ms
```

