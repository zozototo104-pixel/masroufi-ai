# CI Verification Report

Source commit: c139ffdbbf2dd48b0c8bf7aee95a1f4df96ea692
Run: 34825998383
Install: success
Tests: failure
TypeScript: failure
Build: success
Runtime: cancelled
Audit: success

## failing tests
```text
not ok 7 - AUTH-07: server cannot mint a Firebase identity from an email claim
  ---
  duration_ms: 44.645186
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
  duration_ms: 1.797196
  type: 'test'
  ...
# Subtest: AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
ok 9 - AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
  ---
  duration_ms: 36.159608
  type: 'test'
  ...
# Subtest: AUTHZ-04: deleteReport ownership check exists
ok 10 - AUTHZ-04: deleteReport ownership check exists
  ---
  duration_ms: 7.477995
  type: 'test'
  ...
not ok 15 - TOOL-02/03: addTransaction debt guard present (HF-7)
  ---
  duration_ms: 28.701763
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
  duration_ms: 3.371583
  type: 'test'
  ...
# Subtest: TOOL-05: smart delete asks confirmation even with single match (MF-6)
ok 17 - TOOL-05: smart delete asks confirmation even with single match (MF-6)
  ---
  duration_ms: 6.530675
  type: 'test'
  ...
# Subtest: TOOL-06: memory_search filters by query (MF-2)
ok 18 - TOOL-06: memory_search filters by query (MF-2)
  ---
  duration_ms: 5.838666
  type: 'test'
  ...
not ok 19 - TOOL-07: budget read failure propagates error (HF-6)
  ---
  duration_ms: 6.416762
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:1:5310'
  failureType: 'testCodeFailure'
  error: 'getUserBudgets must not silently fall back to defaults'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:130:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)
ok 20 - TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)
  ---
  duration_ms: 7.024348
  type: 'test'
  ...
# Subtest: TOOL-09: commitments support paid/cancelled status (MF-1)
ok 21 - TOOL-09: commitments support paid/cancelled status (MF-1)
  ---
  duration_ms: 6.495484
  type: 'test'
  ...
# Subtest: TOOL-10: sendPalPayPayment validates amount, balance, phone (HF-3)
ok 22 - TOOL-10: sendPalPayPayment validates amount, balance, phone (HF-3)
  ---
  duration_ms: 10.600464
  type: 'test'
  ...
not ok 43 - CONC-19: treasurerEngine financial report boundary avoids broad any
  ---
  duration_ms: 7.618607
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
  duration_ms: 12.558522
  type: 'test'
  ...
# Subtest: CONC-21: atomic financial guards parse amounts through the shared finite parser
ok 45 - CONC-21: atomic financial guards parse amounts through the shared finite parser
  ---
  duration_ms: 0.789584
  type: 'test'
  ...
# Subtest: CONC-22: savings contributions use Firestore transaction and contribution history
ok 46 - CONC-22: savings contributions use Firestore transaction and contribution history
not ok 60 - DUR-11: transaction update refuses balance-sensitive decisions on partial state
  ---
  duration_ms: 31.305733
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
  duration_ms: 12.182457
  type: 'test'
  ...
# Subtest: DUR-13: restore writes only preflighted transactions and checks durability
ok 62 - DUR-13: restore writes only preflighted transactions and checks durability
  ---
  duration_ms: 6.611403
  type: 'test'
  ...
# Subtest: DUR-14: replace restore is one atomic batch and oversized backups fail before mutation
ok 63 - DUR-14: replace restore is one atomic batch and oversized backups fail before mutation
  ---
  duration_ms: 8.092163
  type: 'test'
  ...
not ok 123 - DOMAIN-03B: credit purchases accept creditor alias and do not require cash preflight
  ---
  duration_ms: 71.21868
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
  duration_ms: 28.99102
  type: 'test'
  ...
# Subtest: DOMAIN-03C: credit purchase changes debt only, not liquid balances
ok 125 - DOMAIN-03C: credit purchase changes debt only, not liquid balances
  ---
  duration_ms: 0.475882
  type: 'test'
  ...
# Subtest: DOMAIN-03D: salary-cycle details expose cash trace so missing cash can be audited
ok 126 - DOMAIN-03D: salary-cycle details expose cash trace so missing cash can be audited
  ---
  duration_ms: 37.999497
  type: 'test'
  ...
not ok 141 - VAULT-07: salary cycle query is bounded by start/end dates and never a full ledger scan
  ---
  duration_ms: 13.862053
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
  duration_ms: 9.899917
  type: 'test'
  ...
# Subtest: VAULT-09: old transaction edits recalculate only affected cycles
ok 143 - VAULT-09: old transaction edits recalculate only affected cycles
  ---
  duration_ms: 6.47201
  type: 'test'
  ...
# Subtest: VAULT-10: voice month questions and explicit date ranges have separate contracts
ok 144 - VAULT-10: voice month questions and explicit date ranges have separate contracts
  ---
  duration_ms: 6.050793
  type: 'test'
  ...
not ok 171 - DELETE-DATE-01: smart delete can find exact-date cash tracking rows outside recent createdAt window
  ---
  duration_ms: 15.349132
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
  duration_ms: 8.05131
  type: 'test'
  ...
# Subtest: MOBILE-01: large app modals are iPhone-safe and scrollable
ok 173 - MOBILE-01: large app modals are iPhone-safe and scrollable
  ---
  duration_ms: 4.269417
  type: 'test'
  ...
# Subtest: VAULT-CURRENCY-01: manual vault carryover preserves original ILS/USD/EUR amounts separately
ok 174 - VAULT-CURRENCY-01: manual vault carryover preserves original ILS/USD/EUR amounts separately
  ---
  duration_ms: 0.518997
  type: 'test'
  ...
not ok 177 - LIVE-01: voice path prevents duplicate expert playback and echo feedback loops
  ---
  duration_ms: 5.862875
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
  duration_ms: 14.498286
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
  duration_ms: 29.68479
  type: 'test'
  ...
# Subtest: CLARIFICATION-03: payment/account clarification must complete the original financial operation without repeating questions
ok 180 - CLARIFICATION-03: payment/account clarification must complete the original financial operation without repeating questions
  ---
  duration_ms: 14.690462
  type: 'test'
  ...
# Subtest: CYCLES-UI-01: Savings Vault exposes salary-cycle navigation details and bounded delete
not ok 181 - CYCLES-UI-01: Savings Vault exposes salary-cycle navigation details and bounded delete
  ---
  duration_ms: 25.999464
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
  duration_ms: 41.48854
  type: 'test'
  ...
# Subtest: PIPE-02: all mutating financial tools are protected by runIdempotent wrapper
ok 183 - PIPE-02: all mutating financial tools are protected by runIdempotent wrapper
  ---
  duration_ms: 23.566263
  type: 'test'
  ...
# Subtest: PIPE-03: idempotency uses hashed Firestore doc ids and fails closed
not ok 184 - PIPE-03: idempotency uses hashed Firestore doc ids and fails closed
  ---
  duration_ms: 18.917812
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
  duration_ms: 14.654851
  type: 'test'
  ...
# Subtest: PIPE-05: chat financial replies are deterministic from tool results, not model interpretation
ok 186 - PIPE-05: chat financial replies are deterministic from tool results, not model interpretation
  ---
  duration_ms: 8.999531
  type: 'test'
  ...
# Subtest: PIPE-06: offline financial commands go through /api/command only
ok 187 - PIPE-06: offline financial commands go through /api/command only
  ---
  duration_ms: 3.298762
  type: 'test'
  ...
not ok 194 - VOICE-06: mobile barge-in resists speaker echo false positives
  ---
  duration_ms: 4.318339
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
  duration_ms: 1.3214
  type: 'test'
  ...
# Subtest: VOICE-08: dormant personal-voice management remains isolated from Live voice runtime
ok 196 - VOICE-08: dormant personal-voice management remains isolated from Live voice runtime
  ---
  duration_ms: 9.321821
  type: 'test'
  ...
# Subtest: FIN-LIVE-01: duplicate in-flight Live write prefers a confirmed committed result
ok 197 - FIN-LIVE-01: duplicate in-flight Live write prefers a confirmed committed result
  ---
  duration_ms: 8.713012
  type: 'test'
  ...
not ok 215 - TREASURER-18: advisor dashboard numbers remain explainable and tied to real transaction dates
  ---
  duration_ms: 12.806606
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:1:53160'
  failureType: 'testCodeFailure'
  error: 'habit analysis must fall back when date-sorted queries miss localDay-only transactions'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:579:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: MARKET-01: extractPricesFromText parses "3200 ₪"
ok 216 - MARKET-01: extractPricesFromText parses "3200 ₪"
  ---
  duration_ms: 1.782299
  type: 'test'
  ...
# Subtest: MARKET-02: extractPricesFromText handles USD/JOD
ok 217 - MARKET-02: extractPricesFromText handles USD/JOD
  ---
  duration_ms: 0.377906
  type: 'test'
  ...
# Subtest: MARKET-03: isGazaSource detects Gaza/Palestine in title/URL
ok 218 - MARKET-03: isGazaSource detects Gaza/Palestine in title/URL
  ---
  duration_ms: 0.168897
  type: 'test'
  ...
```

## not-ok context
```text
32-ok 5 - AUTH-05: malformed Bearer (no token after prefix) rejected
33-  ---
34-  duration_ms: 0.135267
35-  type: 'test'
36-  ...
37-# Subtest: AUTH-06: token with empty uid rejected
38-ok 6 - AUTH-06: token with empty uid rejected
39-  ---
40-  duration_ms: 0.240931
41-  type: 'test'
42-  ...
43-# Subtest: AUTH-07: server cannot mint a Firebase identity from an email claim
44:not ok 7 - AUTH-07: server cannot mint a Firebase identity from an email claim
45-  ---
46-  duration_ms: 44.645186
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
64-  duration_ms: 1.797196
--
92-ok 13 - FIRESTORE-RULES-01: rules file is not empty (CF-7)
93-  ---
94-  duration_ms: 3.388527
95-  type: 'test'
96-  ...
97-# Subtest: TOOL-01: search_market_information declaration REMOVED (HF-1)
98-ok 14 - TOOL-01: search_market_information declaration REMOVED (HF-1)
99-  ---
100-  duration_ms: 21.99162
101-  type: 'test'
102-  ...
103-# Subtest: TOOL-02/03: addTransaction debt guard present (HF-7)
104:not ok 15 - TOOL-02/03: addTransaction debt guard present (HF-7)
105-  ---
106-  duration_ms: 28.701763
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
124-  duration_ms: 3.371583
--
128-ok 17 - TOOL-05: smart delete asks confirmation even with single match (MF-6)
129-  ---
130-  duration_ms: 6.530675
131-  type: 'test'
132-  ...
133-# Subtest: TOOL-06: memory_search filters by query (MF-2)
134-ok 18 - TOOL-06: memory_search filters by query (MF-2)
135-  ---
136-  duration_ms: 5.838666
137-  type: 'test'
138-  ...
139-# Subtest: TOOL-07: budget read failure propagates error (HF-6)
140:not ok 19 - TOOL-07: budget read failure propagates error (HF-6)
141-  ---
142-  duration_ms: 6.416762
143-  type: 'test'
144-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:1:5310'
145-  failureType: 'testCodeFailure'
146:  error: 'getUserBudgets must not silently fall back to defaults'
147:  code: 'ERR_ASSERTION'
148:  name: 'AssertionError'
149-  expected: true
150-  actual: false
151-  operator: '=='
152-  stack: |-
153-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:130:10)
154-    async Test.run (node:internal/test_runner/test:1054:7)
155-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
156-  ...
157-# Subtest: TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)
158-ok 20 - TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)
159-  ---
160-  duration_ms: 7.024348
--
284-ok 41 - CONC-17: tools.ts reuses canonical account normalization instead of duplicating ledger rules
285-  ---
286-  duration_ms: 7.506454
287-  type: 'test'
288-  ...
289-# Subtest: CONC-18: disabled legacy import writer code is not retained as source text
290-ok 42 - CONC-18: disabled legacy import writer code is not retained as source text
291-  ---
292-  duration_ms: 8.835699
293-  type: 'test'
294-  ...
295-# Subtest: CONC-19: treasurerEngine financial report boundary avoids broad any
296:not ok 43 - CONC-19: treasurerEngine financial report boundary avoids broad any
297-  ---
298-  duration_ms: 7.618607
299-  type: 'test'
300-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/concurrency.test.ts:1:15981'
301-  failureType: 'testCodeFailure'
302:  error: |-
303-    treasurerEngine must use explicit local types or unknown at input boundaries instead of broad any
304-    
305-    true !== false
306-    
307:  code: 'ERR_ASSERTION'
308:  name: 'AssertionError'
309-  expected: false
310-  actual: true
311-  operator: 'strictEqual'
312-  stack: |-
313-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/concurrency.test.ts:258:10)
314-    async Test.run (node:internal/test_runner/test:1054:7)
315-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
316-  ...
317-# Subtest: CONC-20: tools financial amounts use the shared finite amount parser
318-ok 44 - CONC-20: tools financial amounts use the shared finite amount parser
319-  ---
320-  duration_ms: 12.558522
--
402-ok 58 - DUR-09: legacy pending financial documents are quarantined, never guessed as ADD_TRANSACTION
403-  ---
404-  duration_ms: 1.266363
405-  type: 'test'
406-  ...
407-# Subtest: DUR-10: transaction delete is durability-safe through atomic Firestore deletion
408-ok 59 - DUR-10: transaction delete is durability-safe through atomic Firestore deletion
409-  ---
410-  duration_ms: 11.861602
411-  type: 'test'
412-  ...
413-# Subtest: DUR-11: transaction update refuses balance-sensitive decisions on partial state
414:not ok 60 - DUR-11: transaction update refuses balance-sensitive decisions on partial state
415-  ---
416-  duration_ms: 31.305733
417-  type: 'test'
418-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:1:7056'
419-  failureType: 'testCodeFailure'
420:  error: 'updateTransaction must use atomic snapshot balance updates and fail closed on uncertain bounded budget reads'
421:  code: 'ERR_ASSERTION'
422:  name: 'AssertionError'
423-  expected: true
424-  actual: false
425-  operator: '=='
426-  stack: |-
427-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/durability.test.ts:162:10)
428-    async Test.run (node:internal/test_runner/test:1054:7)
429-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
430-  ...
431-# Subtest: DUR-12: restore validates the full backup before replace deletes existing state
432-ok 61 - DUR-12: restore validates the full backup before replace deletes existing state
433-  ---
434-  duration_ms: 12.182457
--
792-ok 121 - DOMAIN-02: creditor identity normalization collapses Arabic spelling/diacritic variants
793-  ---
794-  duration_ms: 0.106366
795-  type: 'test'
796-  ...
797-# Subtest: DOMAIN-03: creditor remaining is reconstructed behaviorally from purchases and repayments
798-ok 122 - DOMAIN-03: creditor remaining is reconstructed behaviorally from purchases and repayments
799-  ---
800-  duration_ms: 0.369893
801-  type: 'test'
802-  ...
803-# Subtest: DOMAIN-03B: credit purchases accept creditor alias and do not require cash preflight
804:not ok 123 - DOMAIN-03B: credit purchases accept creditor alias and do not require cash preflight
805-  ---
806-  duration_ms: 71.21868
807-  type: 'test'
808-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:24585'
809-  failureType: 'testCodeFailure'
810:  error: 'addTransaction must identify credit purchases before cash/PalPay preflight'
811:  code: 'ERR_ASSERTION'
812:  name: 'AssertionError'
813-  expected: true
814-  actual: false
815-  operator: '=='
816-  stack: |-
817-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:562:10)
818-    async Test.run (node:internal/test_runner/test:1054:7)
819-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
820-  ...
821-# Subtest: DOMAIN-03B2: salary cycle details expose credit purchases under a debt bucket
822-ok 124 - DOMAIN-03B2: salary cycle details expose credit purchases under a debt bucket
823-  ---
824-  duration_ms: 28.99102
--
912-ok 139 - VAULT-05: positive, zero, and deficit cycle surplus behavior is explicit
913-  ---
914-  duration_ms: 0.40259
915-  type: 'test'
916-  ...
917-# Subtest: VAULT-06: Arabic month 7 resolves as salary cycle July, not calendar July
918-ok 140 - VAULT-06: Arabic month 7 resolves as salary cycle July, not calendar July
919-  ---
920-  duration_ms: 0.570765
921-  type: 'test'
922-  ...
923-# Subtest: VAULT-07: salary cycle query is bounded by start/end dates and never a full ledger scan
924:not ok 141 - VAULT-07: salary cycle query is bounded by start/end dates and never a full ledger scan
925-  ---
926-  duration_ms: 13.862053
927-  type: 'test'
928-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:41489'
929-  failureType: 'testCodeFailure'
930:  error: 'cycle query must lower-bound date'
931:  code: 'ERR_ASSERTION'
932:  name: 'AssertionError'
933-  expected: true
934-  actual: false
935-  operator: '=='
936-  stack: |-
937-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:822:10)
938-    async Test.run (node:internal/test_runner/test:1054:7)
939-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
940-  ...
941-# Subtest: VAULT-08: recalculating the same cycle is idempotent through one salaryCycles doc
942-ok 142 - VAULT-08: recalculating the same cycle is idempotent through one salaryCycles doc
943-  ---
944-  duration_ms: 9.899917
--
1104-ok 169 - IMPORT-02: receipt record uses server balances and splits cash to PalPay before debt
1105-  ---
1106-  duration_ms: 6.326421
1107-  type: 'test'
1108-  ...
1109-# Subtest: DELETE-RECENT-01: voice can safely delete last N expenses or last debt payment without full ledger scan
1110-ok 170 - DELETE-RECENT-01: voice can safely delete last N expenses or last debt payment without full ledger scan
1111-  ---
1112-  duration_ms: 10.837216
1113-  type: 'test'
1114-  ...
1115-# Subtest: DELETE-DATE-01: smart delete can find exact-date cash tracking rows outside recent createdAt window
1116:not ok 171 - DELETE-DATE-01: smart delete can find exact-date cash tracking rows outside recent createdAt window
1117-  ---
1118-  duration_ms: 15.349132
1119-  type: 'test'
1120-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:88907'
1121-  failureType: 'testCodeFailure'
1122:  error: 'smart delete must query the exact transaction date instead of only recent createdAt rows'
1123:  code: 'ERR_ASSERTION'
1124:  name: 'AssertionError'
1125-  expected: true
1126-  actual: false
1127-  operator: '=='
1128-  stack: |-
1129-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1228:10)
1130-    async Test.run (node:internal/test_runner/test:1054:7)
1131-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1132-  ...
1133-# Subtest: DEBT-REPORT-01: salary-cycle debt questions include repayments made after the cycle
1134-ok 172 - DEBT-REPORT-01: salary-cycle debt questions include repayments made after the cycle
1135-  ---
1136-  duration_ms: 8.05131
--
1152-ok 175 - VAULT-CURRENCY-02: currency deltas can be repaired from old and new vault adjustment shapes
1153-  ---
1154-  duration_ms: 0.388383
1155-  type: 'test'
1156-  ...
1157-# Subtest: VAULT-CURRENCY-03: tools and UI expose multi-currency vault fields without touching cash/PalPay/debt
1158-ok 176 - VAULT-CURRENCY-03: tools and UI expose multi-currency vault fields without touching cash/PalPay/debt
1159-  ---
1160-  duration_ms: 17.570264
1161-  type: 'test'
1162-  ...
1163-# Subtest: LIVE-01: voice path prevents duplicate expert playback and echo feedback loops
1164:not ok 177 - LIVE-01: voice path prevents duplicate expert playback and echo feedback loops
1165-  ---
1166-  duration_ms: 5.862875
1167-  type: 'test'
1168-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:115691'
1169-  failureType: 'testCodeFailure'
1170:  error: 'barge-in threshold must resist speaker echo false positives'
1171:  code: 'ERR_ASSERTION'
1172:  name: 'AssertionError'
1173-  expected: true
1174-  actual: false
1175-  operator: '=='
1176-  stack: |-
1177-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1342:10)
1178-    async Test.run (node:internal/test_runner/test:1054:7)
1179-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1180-  ...
1181-# Subtest: LIVE-02: Gemini Live quota exhaustion is classified and surfaced to the user
1182:not ok 178 - LIVE-02: Gemini Live quota exhaustion is classified and surfaced to the user
1183-  ---
1184-  duration_ms: 14.498286
1185-  type: 'test'
1186-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:119469'
1187-  failureType: 'testCodeFailure'
1188:  error: 'client must boost quiet Gemini Live playback loudly through one persistent compressed output chain without changing microphone input and must clean up audio nodes'
1189:  code: 'ERR_ASSERTION'
1190:  name: 'AssertionError'
1191-  expected: true
1192-  actual: false
1193-  operator: '=='
1194-  stack: |-
1195-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1375:10)
1196-    async Test.run (node:internal/test_runner/test:1054:7)
1197-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1198-  ...
1199-# Subtest: REPORTS-06: Treasurer/monthly expense analysis must not refuse or misroute to today reads
1200-ok 179 - REPORTS-06: Treasurer/monthly expense analysis must not refuse or misroute to today reads
1201-  ---
1202-  duration_ms: 29.68479
1203-  type: 'test'
1204-  ...
1205-# Subtest: CLARIFICATION-03: payment/account clarification must complete the original financial operation without repeating questions
1206-ok 180 - CLARIFICATION-03: payment/account clarification must complete the original financial operation without repeating questions
1207-  ---
1208-  duration_ms: 14.690462
1209-  type: 'test'
1210-  ...
1211-# Subtest: CYCLES-UI-01: Savings Vault exposes salary-cycle navigation details and bounded delete
1212:not ok 181 - CYCLES-UI-01: Savings Vault exposes salary-cycle navigation details and bounded delete
1213-  ---
1214-  duration_ms: 25.999464
1215-  type: 'test'
1216-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1:131935'
1217-  failureType: 'testCodeFailure'
1218:  error: 'cycle query must remain bounded to the selected 27→26 date range'
1219:  code: 'ERR_ASSERTION'
1220:  name: 'AssertionError'
1221-  expected: true
1222-  actual: false
1223-  operator: '=='
1224-  stack: |-
1225-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial.test.ts:1441:10)
1226-    async Test.run (node:internal/test_runner/test:1054:7)
1227-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1228-  ...
1229-# Subtest: PIPE-01: financial writes must not pass through legacy /api/sync raw transaction doc.set
1230-ok 182 - PIPE-01: financial writes must not pass through legacy /api/sync raw transaction doc.set
1231-  ---
1232-  duration_ms: 41.48854
1233-  type: 'test'
1234-  ...
1235-# Subtest: PIPE-02: all mutating financial tools are protected by runIdempotent wrapper
1236-ok 183 - PIPE-02: all mutating financial tools are protected by runIdempotent wrapper
1237-  ---
1238-  duration_ms: 23.566263
1239-  type: 'test'
1240-  ...
1241-# Subtest: PIPE-03: idempotency uses hashed Firestore doc ids and fails closed
1242:not ok 184 - PIPE-03: idempotency uses hashed Firestore doc ids and fails closed
1243-  ---
1244-  duration_ms: 18.917812
1245-  type: 'test'
1246-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:1:1913'
1247-  failureType: 'testCodeFailure'
1248:  error: 'pending duplicates may wait only after the claim transaction has completed'
1249:  code: 'ERR_ASSERTION'
1250:  name: 'AssertionError'
1251-  expected: true
1252-  actual: false
1253-  operator: '=='
1254-  stack: |-
1255-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:43:10)
1256-    async Test.run (node:internal/test_runner/test:1054:7)
1257-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1258-  ...
1259-# Subtest: PIPE-04: notifications cannot turn a committed financial write into a failure
1260-ok 185 - PIPE-04: notifications cannot turn a committed financial write into a failure
1261-  ---
1262-  duration_ms: 14.654851
--
1302-ok 192 - VOICE-04: Gemini Live forwards native audio without personal-voice interception
1303-  ---
1304-  duration_ms: 8.33681
1305-  type: 'test'
1306-  ...
1307-# Subtest: VOICE-05: interruption handling matches the original Gemini Live path
1308-ok 193 - VOICE-05: interruption handling matches the original Gemini Live path
1309-  ---
1310-  duration_ms: 5.798462
1311-  type: 'test'
1312-  ...
1313-# Subtest: VOICE-06: mobile barge-in resists speaker echo false positives
1314:not ok 194 - VOICE-06: mobile barge-in resists speaker echo false positives
1315-  ---
1316-  duration_ms: 4.318339
1317-  type: 'test'
1318-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:1:7858'
1319-  failureType: 'testCodeFailure'
1320:  error: 'barge-in must use a higher speech threshold to avoid echo-triggered cuts'
1321:  code: 'ERR_ASSERTION'
1322:  name: 'AssertionError'
1323-  expected: true
1324-  actual: false
1325-  operator: '=='
1326-  stack: |-
1327-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:120:10)
1328-    async Test.run (node:internal/test_runner/test:1054:7)
1329-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1330-  ...
1331-# Subtest: VOICE-07: websocket connect reads the latest selected voice
1332-ok 195 - VOICE-07: websocket connect reads the latest selected voice
1333-  ---
1334-  duration_ms: 1.3214
--
1440-ok 213 - TREASURER-16: month-end forecast engine predicts surplus pressure or deficit with corrections
1441-  ---
1442-  duration_ms: 11.150588
1443-  type: 'test'
1444-  ...
1445-# Subtest: TREASURER-17: daily financial pulse gives a practical today plan without pretending background automation
1446-ok 214 - TREASURER-17: daily financial pulse gives a practical today plan without pretending background automation
1447-  ---
1448-  duration_ms: 13.420074
1449-  type: 'test'
1450-  ...
1451-# Subtest: TREASURER-18: advisor dashboard numbers remain explainable and tied to real transaction dates
1452:not ok 215 - TREASURER-18: advisor dashboard numbers remain explainable and tied to real transaction dates
1453-  ---
1454-  duration_ms: 12.806606
1455-  type: 'test'
1456-  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:1:53160'
1457-  failureType: 'testCodeFailure'
1458:  error: 'habit analysis must fall back when date-sorted queries miss localDay-only transactions'
1459:  code: 'ERR_ASSERTION'
1460:  name: 'AssertionError'
1461-  expected: true
1462-  actual: false
1463-  operator: '=='
1464-  stack: |-
1465-    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/financial_pipeline.test.ts:579:10)
1466-    async Test.run (node:internal/test_runner/test:1054:7)
1467-    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
1468-  ...
1469-# Subtest: MARKET-01: extractPricesFromText parses "3200 ₪"
1470-ok 216 - MARKET-01: extractPricesFromText parses "3200 ₪"
1471-  ---
1472-  duration_ms: 1.782299
```

## install
```text
npm warn deprecated glob@10.5.0: Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me

added 543 packages, and audited 544 packages in 15s

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
  duration_ms: 1.708221
  type: 'test'
  ...
# Subtest: AUTH-02: missing Authorization header rejected
ok 2 - AUTH-02: missing Authorization header rejected
  ---
  duration_ms: 0.206055
  type: 'test'
  ...
# Subtest: AUTH-03: no default-user fallback — invalid token stays 401
ok 3 - AUTH-03: no default-user fallback — invalid token stays 401
  ---
  duration_ms: 0.319996
  type: 'test'
  ...
# Subtest: AUTH-04: valid Firebase ID token accepted
ok 4 - AUTH-04: valid Firebase ID token accepted
  ---
  duration_ms: 0.168672
  type: 'test'
  ...
# Subtest: AUTH-05: malformed Bearer (no token after prefix) rejected
ok 5 - AUTH-05: malformed Bearer (no token after prefix) rejected
  ---
  duration_ms: 0.135267
  type: 'test'
  ...
# Subtest: AUTH-06: token with empty uid rejected
ok 6 - AUTH-06: token with empty uid rejected
  ---
  duration_ms: 0.240931
  type: 'test'
  ...
# Subtest: AUTH-07: server cannot mint a Firebase identity from an email claim
not ok 7 - AUTH-07: server cannot mint a Firebase identity from an email claim
  ---
  duration_ms: 44.645186
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
  duration_ms: 1.797196
  type: 'test'
  ...
# Subtest: AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
ok 9 - AUTHZ-01/02/03 + SYNC-01: /api/sync enforces ownership via assertOwnership-style check
  ---
  duration_ms: 36.159608
  type: 'test'
  ...
# Subtest: AUTHZ-04: deleteReport ownership check exists
ok 10 - AUTHZ-04: deleteReport ownership check exists
  ---
  duration_ms: 7.477995
  type: 'test'
  ...
# Subtest: AUTHZ-05: deleteCommitment ownership check exists
ok 11 - AUTHZ-05: deleteCommitment ownership check exists
  ---
  duration_ms: 20.472493
  type: 'test'
  ...
# Subtest: AUTHZ-06: update_transaction ownership check exists
ok 12 - AUTHZ-06: update_transaction ownership check exists
  ---
  duration_ms: 16.683539
  type: 'test'
  ...
# Subtest: FIRESTORE-RULES-01: rules file is not empty (CF-7)
ok 13 - FIRESTORE-RULES-01: rules file is not empty (CF-7)
  ---
  duration_ms: 3.388527
  type: 'test'
  ...
# Subtest: TOOL-01: search_market_information declaration REMOVED (HF-1)
ok 14 - TOOL-01: search_market_information declaration REMOVED (HF-1)
  ---
  duration_ms: 21.99162
  type: 'test'
  ...
# Subtest: TOOL-02/03: addTransaction debt guard present (HF-7)
not ok 15 - TOOL-02/03: addTransaction debt guard present (HF-7)
  ---
  duration_ms: 28.701763
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
  duration_ms: 3.371583
  type: 'test'
  ...
# Subtest: TOOL-05: smart delete asks confirmation even with single match (MF-6)
ok 17 - TOOL-05: smart delete asks confirmation even with single match (MF-6)
  ---
  duration_ms: 6.530675
  type: 'test'
  ...
# Subtest: TOOL-06: memory_search filters by query (MF-2)
ok 18 - TOOL-06: memory_search filters by query (MF-2)
  ---
  duration_ms: 5.838666
  type: 'test'
  ...
# Subtest: TOOL-07: budget read failure propagates error (HF-6)
not ok 19 - TOOL-07: budget read failure propagates error (HF-6)
  ---
  duration_ms: 6.416762
  type: 'test'
  location: '/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:1:5310'
  failureType: 'testCodeFailure'
  error: 'getUserBudgets must not silently fall back to defaults'
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  stack: |-
    TestContext.<anonymous> (/home/runner/work/masroufi-ai/masroufi-ai/tests/authorization.test.ts:130:10)
    async Test.run (node:internal/test_runner/test:1054:7)
    async Test.processPendingSubtests (node:internal/test_runner/test:744:7)
  ...
# Subtest: TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)
ok 20 - TOOL-08: getFinancialDecisionContext propagates partial flag (DUR-04/28)
  ---
  duration_ms: 7.024348
  type: 'test'
  ...
# Subtest: TOOL-09: commitments support paid/cancelled status (MF-1)
ok 21 - TOOL-09: commitments support paid/cancelled status (MF-1)
  ---
  duration_ms: 6.495484
  type: 'test'
  ...
# Subtest: TOOL-10: sendPalPayPayment validates amount, balance, phone (HF-3)
ok 22 - TOOL-10: sendPalPayPayment validates amount, balance, phone (HF-3)
  ---
  duration_ms: 10.600464
  type: 'test'
  ...
# Subtest: CONC-01: add_transaction commits through Firestore atomic path, not FakeDb pending fallback
ok 23 - CONC-01: add_transaction commits through Firestore atomic path, not FakeDb pending fallback
  ---
  duration_ms: 24.182274
  type: 'test'
  ...
# Subtest: CONC-02: PalPay expense uses atomic guard (same code path)
ok 24 - CONC-02: PalPay expense uses atomic guard (same code path)
  ---
  duration_ms: 6.958976
  type: 'test'
  ...
# Subtest: CONC-03: payDebt uses atomicPayDebt (concurrent payment protection)
ok 25 - CONC-03: payDebt uses atomicPayDebt (concurrent payment protection)
  ---
  duration_ms: 7.84759
  type: 'test'
  ...
# Subtest: CONC-04: same operationId executes once (idempotency layer)
ok 26 - CONC-04: same operationId executes once (idempotency layer)
  ---
  duration_ms: 1.320634
  type: 'test'
  ...
# Subtest: CONC-05: concurrent update + expense preserves invariant (NEGATIVE_CASH_RESULT guard)
ok 27 - CONC-05: concurrent update + expense preserves invariant (NEGATIVE_CASH_RESULT guard)
  ---
  duration_ms: 6.00426
  type: 'test'
  ...
# Subtest: CONC-06: atomicAddTransaction exists in atomicOps.ts
ok 28 - CONC-06: atomicAddTransaction exists in atomicOps.ts
  ---
  duration_ms: 1.67765
  type: 'test'
  ...
# Subtest: CONC-07: atomicPayDebt recomputes creditor remaining through the shared domain core
ok 29 - CONC-07: atomicPayDebt recomputes creditor remaining through the shared domain core
  ---
  duration_ms: 2.02368
  type: 'test'
  ...
# Subtest: CONC-08: atomicOps has no circular dependency on tools.ts
ok 30 - CONC-08: atomicOps has no circular dependency on tools.ts
  ---
  duration_ms: 3.060993
--- tests log tail ---
  ...
# Subtest: MARKET-23: Bank of Israel FX payload parser preserves representative source date
ok 238 - MARKET-23: Bank of Israel FX payload parser preserves representative source date
  ---
  duration_ms: 0.499365
  type: 'test'
  ...
# Subtest: MARKET-24: converted FX market results expose source/date metadata and reject Infinity
ok 239 - MARKET-24: converted FX market results expose source/date metadata and reject Infinity
  ---
  duration_ms: 4.563578
  type: 'test'
  ...
# Subtest: MARKET-25: saved and live market results spread FX metadata when conversion succeeds
ok 240 - MARKET-25: saved and live market results spread FX metadata when conversion succeeds
  ---
  duration_ms: 6.587069
  type: 'test'
  ...
# Subtest: OFF-01: FakeDb.set returns durability=pending on Firestore failure
ok 241 - OFF-01: FakeDb.set returns durability=pending on Firestore failure
  ---
  duration_ms: 9.676655
  type: 'test'
  ...
# Subtest: OFF-02: offline queue persists in IndexedDB (survives browser reload)
ok 242 - OFF-02: offline queue persists in IndexedDB (survives browser reload)
  ---
  duration_ms: 1.574027
  type: 'test'
  ...
# Subtest: OFF-03: queue keyed by userId (survives Cloud Run restart, client-side)
ok 243 - OFF-03: queue keyed by userId (survives Cloud Run restart, client-side)
  ---
  duration_ms: 2.903049
  type: 'test'
  ...
# Subtest: OFF-04: syncPendingOps attempts to sync on fetchData
ok 244 - OFF-04: syncPendingOps attempts to sync on fetchData
  ---
  duration_ms: 2.967434
  type: 'test'
  ...
# Subtest: OFF-05: retry does not duplicate after the operation completed
ok 245 - OFF-05: retry does not duplicate after the operation completed
  ---
  duration_ms: 0.510847
  type: 'test'
  ...
# Subtest: OFF-06: server committed but response lost — retry returns cached result
ok 246 - OFF-06: server committed but response lost — retry returns cached result
  ---
  duration_ms: 1.108122
  type: 'test'
  ...
# Subtest: OFF-06B: offline income parser cannot manufacture server business confirmations
ok 247 - OFF-06B: offline income parser cannot manufacture server business confirmations
  ---
  duration_ms: 4.545948
  type: 'test'
  ...
# Subtest: OFF-07: Login A → logout → Login B cannot see/sync A queue
ok 248 - OFF-07: Login A → logout → Login B cannot see/sync A queue
  ---
  duration_ms: 2.813109
  type: 'test'
  ...
# Subtest: OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
ok 249 - OFF-08: pending ops include operationId, userId, commandType, args, createdAt, retryCount
  ---
  duration_ms: 1.221301
  type: 'test'
  ...
# Subtest: OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
ok 250 - OFF-09: pending ops carry syncStatus states (PENDING, SYNCING, COMMITTED, FAILED)
  ---
  duration_ms: 1.298396
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
ok 251 - ATOMIC-DEBT-01: payDebt no longer has txRef.set fallback after atomic failure
  ---
  duration_ms: 13.311582
  type: 'test'
  ...
# Subtest: ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
ok 252 - ATOMIC-DEBT-02: payDebt returns retryable=true on contention/quota
  ---
  duration_ms: 9.492535
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
ok 253 - TRANSFER-CONC-01: transferMoney uses atomicTransferMoney
  ---
  duration_ms: 6.294654
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
ok 254 - TRANSFER-CONC-02: atomicTransferMoney exists in atomicOps
  ---
  duration_ms: 1.882576
  type: 'test'
  ...
# Subtest: TRANSFER-CONC-03: transferMoney has NO direct write fallback
ok 255 - TRANSFER-CONC-03: transferMoney has NO direct write fallback
  ---
  duration_ms: 5.639492
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
ok 256 - OFFLINE-COMMAND-01: offlineQueue stores commandType + args (not final document)
  ---
  duration_ms: 0.952223
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
ok 257 - OFFLINE-COMMAND-02: offlineQueue sends through /api/command (NOT /api/sync)
  ---
  duration_ms: 2.425206
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
ok 258 - OFFLINE-COMMAND-03: /api/command endpoint exists in server.ts
  ---
  duration_ms: 3.578662
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
ok 259 - OFFLINE-COMMAND-04: dispatchFinancialCommand routes to tool handlers
  ---
  duration_ms: 10.743945
  type: 'test'
  ...
# Subtest: OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
ok 260 - OFFLINE-COMMAND-05: /api/sync is NOT a financial backdoor (syncOfflineData does doc.set for non-financial only)
  ---
  duration_ms: 1.677311
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
ok 261 - UNIFIED-PENDING-01: V6.2 uses new queue key (masrofi_pending_ops_v6_2)
  ---
  duration_ms: 0.791787
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
ok 262 - UNIFIED-PENDING-02: migrateLegacyPendingOps function exists
  ---
  duration_ms: 1.070769
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
ok 263 - UNIFIED-PENDING-03: App.tsx calls migrateLegacyPendingOps on fetchData
  ---
  duration_ms: 5.082188
  type: 'test'
  ...
# Subtest: UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
ok 264 - UNIFIED-PENDING-04: logout clears ALL pending keys (v6_2 + legacy)
  ---
  duration_ms: 2.373924
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-01: addTransaction rejects on partial snapshot
ok 265 - PARTIAL-STATE-01: addTransaction rejects on partial snapshot
  ---
  duration_ms: 5.29
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-02: transferMoney rejects on partial balance
ok 266 - PARTIAL-STATE-02: transferMoney rejects on partial balance
  ---
  duration_ms: 7.34373
  type: 'test'
  ...
# Subtest: PARTIAL-STATE-03: payDebt rejects on partial snapshot
ok 267 - PARTIAL-STATE-03: payDebt rejects on partial snapshot
  ---
  duration_ms: 4.279811
  type: 'test'
  ...
# Subtest: FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
ok 268 - FIRESTORE-READS-01: atomic ops use runTransaction (O(N) acknowledged, V7 will add financialState)
  ---
  duration_ms: 0.819443
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
ok 269 - STATIC-SAFETY-01: no "catch + txRef.set" pattern in payDebt
  ---
  duration_ms: 4.732438
  type: 'test'
  ...
# Subtest: STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
ok 270 - STATIC-SAFETY-02: no "catch + txRef.set" pattern in transferMoney
  ---
  duration_ms: 6.537541
  type: 'test'
  ...
# Subtest: SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
ok 271 - SYNC-AUTH-01: dispatchFinancialCommand overwrites client userId
  ---
  duration_ms: 0.675204
  type: 'test'
  ...
# Subtest: IDEM-01: dispatchFinancialCommand passes operationId through args
ok 272 - IDEM-01: dispatchFinancialCommand passes operationId through args
  ---
  duration_ms: 3.549375
  type: 'test'
  ...
1..272
# tests 272
# suites 0
# pass 258
# fail 14
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2632.619082
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
src/server/tools.ts(1162,8): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(1510,200): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(1882,199): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(2274,213): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(2320,23): error TS2339: Property 'id' does not exist on type '{ exists: boolean; data: () => any; partial: boolean; error?: undefined; } | { exists: boolean; data: () => any; partial: boolean; error: any; }'.
  Property 'id' does not exist on type '{ exists: boolean; data: () => any; partial: boolean; error?: undefined; }'.
src/server/tools.ts(2342,8): error TS2554: Expected 2 arguments, but got 3.
src/server/tools.ts(2350,8): error TS2554: Expected 2 arguments, but got 3.
src/server/tools.ts(2376,39): error TS2339: Property 'id' does not exist on type 'SalaryCyclePeriod'.
src/server/tools.ts(2573,205): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(2912,198): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(3277,79): error TS2339: Property 'decision' does not exist on type '{ success: boolean; decision: string; message: string; safeSpending: { currency: any; horizon: { period: string; label: string; startIso: string; endIso: string; daysRemaining: number; salaryCycle: SalaryCyclePeriod; }; ... 11 more ...; cashFlowGap: number; }; ... 7 more ...; readEfficiency: any; } | { ...; }'.
  Property 'decision' does not exist on type '{ success: boolean; message: any; }'.
src/server/tools.ts(3277,108): error TS2339: Property 'safeSpending' does not exist on type '{ success: boolean; decision: string; message: string; safeSpending: { currency: any; horizon: { period: string; label: string; startIso: string; endIso: string; daysRemaining: number; salaryCycle: SalaryCyclePeriod; }; ... 11 more ...; cashFlowGap: number; }; ... 7 more ...; readEfficiency: any; } | { ...; }'.
  Property 'safeSpending' does not exist on type '{ success: boolean; message: any; }'.
src/server/tools.ts(3285,65): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(3366,24): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(3728,5): error TS2322: Type '"" | "cash" | "palPay" | "debt"' is not assignable to type '"cash" | "palPay" | "debt"'.
  Type '""' is not assignable to type '"cash" | "palPay" | "debt"'.
src/server/tools.ts(6433,8): error TS2554: Expected 1 arguments, but got 2.
src/server/tools.ts(7592,33): error TS2339: Property 'id' does not exist on type 'SalaryCyclePeriod'.
src/server/tools.ts(8493,44): error TS2554: Expected 1 arguments, but got 2.
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
[2mdist/[22m[2massets/[22m[36mindex-BKfwWT0A.js            [39m[1m[2m304.83 kB[22m[1m[22m[2m │ gzip:  71.18 kB[22m[2m │ map:   759.29 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-firebase-ChFgjPjV.js  [39m[1m[2m337.41 kB[22m[1m[22m[2m │ gzip:  78.75 kB[22m[2m │ map: 2,305.04 kB[22m
[2mdist/[22m[2massets/[22m[36mvendor-BCsGZLxX.js           [39m[1m[2m489.72 kB[22m[1m[22m[2m │ gzip: 151.90 kB[22m[2m │ map: 2,114.73 kB[22m
[32m✓ built in 4.89s[39m

  dist/server.cjs      1.4mb ⚠️
  dist/server.cjs.map  2.1mb

⚡ Done in 70ms
```

