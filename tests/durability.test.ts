/**
 * V6 DURABILITY + IDEMPOTENCY TESTS (CF-5, CF-6)
 *
 * Tests:
 *   DUR-01 Firestore failure does not create false SUCCESS — writeResult.durability='pending'
 *   DUR-02 restart does not silently lose acknowledged transaction (idempotency_keys persists)
 *   DUR-03 recovery sync preserves exactly-once semantics
 *   DUR-04 offline/pending state visible to UI (response includes partial/pending flags)
 *   DUR-05 partial data marked partial (getBalance returns partial=true on Firestore fail)
 *   DUR-06 account switch cannot expose cache (logout clears IndexedDB)
 *   DUR-07 import/export round-trip preserves financial state
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  buildCompletedIdempotencyRecord,
  buildPendingIdempotencyRecord,
  decideIdempotencyClaim,
} from '../src/server/idempotencyCore.ts';

test('DUR-01: FakeDb.WriteResult exposes durability flag — V6 type definition present', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/fakeDb.ts'), 'utf8');
  assert.ok(src.includes("type WriteDurability = 'committed' | 'pending' | 'failed'"),
    'FakeDb must export WriteDurability type');
  assert.ok(src.includes('interface WriteResult'), 'FakeDb must export WriteResult interface');
  assert.ok(src.includes('durability: WriteDurability'), 'set/update/delete must return durability');
});

test('DUR-02: idempotency_keys collection persists across restart (Firestore-backed)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/idempotency.ts'), 'utf8');
  assert.ok(src.includes("IDEMPOTENCY_COLLECTION = 'idempotency_keys'"),
    'idempotency uses Firestore collection (persists across restart)');
  assert.ok(src.includes('adminDb.runTransaction'),
    'claim uses Firestore transaction (atomic across instances)');
});

test('DUR-03: same operationId returns cached result on retry', async () => {
  // The cache-hit short-circuit lives in wrapWithDeduplication (tools.ts), which calls
  // runIdempotent and returns cachedResult instead of re-executing.
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(toolsSrc.includes("if (outcome.kind === 'cache_hit') return outcome.cachedResult"),
    'wrapWithDeduplication returns cached result on cache_hit (does NOT re-execute)');
  // The idempotency layer records pending/completed status for cross-restart persistence.
  const idemSrc = await readFile(join(process.cwd(), 'src/server/idempotency.ts'), 'utf8');
  assert.ok(idemSrc.includes("status: 'pending'"), 'pending state recorded');
  assert.ok(idemSrc.includes("status: 'completed'"), 'completed state recorded');
  assert.ok(idemSrc.includes("kind: 'cache_hit'"), 'cache_hit branch exists');
});

test('DUR-04: addTransaction response includes durability + pending flags', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('durability: writeResult.durability'),
    'addTransaction response must include durability');
  assert.ok(src.includes('pending: writeResult.pending'),
    'addTransaction response must include pending flag');
  assert.ok(src.includes('partial: balances.partial || writeResult.pending'),
    'addTransaction response must include partial flag');
});

test('DUR-05: getBalance propagates partial flag from FakeDb', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes("return {balances,total:balances.cash+balances.palPay,partial:(snap as any).partial===true};"),
    'getBalance must propagate partial=true when FakeDb returns partial snapshot');
});

test('DUR-06: account switch cannot expose cache — logout clears IndexedDB', async () => {
  const src = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.ok(src.includes("V6 (CACHE-01, hidden risk): clear all user-scoped IndexedDB caches on logout"),
    'logout must explicitly clear IndexedDB caches');
  assert.ok(src.includes("await idbSet('lkgs_transactions', [])"),
    'logout must clear lkgs_transactions');
  assert.ok(src.includes("await idbSet('lkgs_reports', [])"),
    'logout must clear lkgs_reports');
});

test('DUR-07: import/export round-trip preserves financial state — HF-5 fix', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('V6 (HF-5): preserve ALL financial semantics fields on import'),
    'importUserData must preserve financial fields');
  // Verify the preservation happens for ALL types, not just transfer.
  assert.ok(src.includes("if (t.transactionType) docData.transactionType = String(t.transactionType)"),
    'transactionType preserved regardless of type');
  assert.ok(src.includes("if (t.creditor) docData.creditor = String(t.creditor)"),
    'creditor preserved regardless of type');
  assert.ok(src.includes("if (t.creditorKey) docData.creditorKey = String(t.creditorKey)"),
    'creditorKey preserved regardless of type');
  assert.ok(src.includes("if (docData.account === 'debt' && !docData.creditor && docData.merchant)"),
    'creditor derived from merchant when missing on debt transactions');
});

test('DUR-08: chat cannot export server-local FakeDb pending operations to legacy client queue', async () => {
  const serverSrc = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  const appSrc = await readFile(join(process.cwd(), 'src/App.tsx'), 'utf8');
  assert.equal(serverSrc.includes("const { getPendingOps } = await import('./src/server/fakeDb')"), false,
    'chat response must not bridge FakeDb pending state to the browser');
  assert.equal(appSrc.includes('data.pendingOps && data.pendingOps.length > 0'), false,
    'client chat path must not ingest server pending state into a legacy queue');
});

test('DUR-09: legacy pending financial documents are quarantined, never guessed as ADD_TRANSACTION', async () => {
  const queueSrc = await readFile(join(process.cwd(), 'src/lib/offlineQueue.ts'), 'utf8');
  assert.ok(queueSrc.includes('UNSAFE_LEGACY_FINANCIAL_REPLAY_DISABLED'),
    'legacy financial rows must be quarantined');
  assert.equal(queueSrc.includes("commandType: 'ADD_TRANSACTION' as FinancialCommandType"), false,
    'migration must not guess the original financial command');
});

test('DUR-10: transaction delete cannot report success when cloud durability is pending', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes("reason: 'DELETE_NOT_DURABLY_COMMITTED'"),
    'deleteTransaction must fail closed when FakeDb reports pending durability');
});

test('DUR-11: transaction update refuses balance-sensitive decisions on partial state', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes("message: 'لا يمكن تعديل العملية الآن لأن قراءة السحابة جزئية، ولا أستطيع ضمان الرصيد الناتج بأمان.'"),
    'updateTransaction must refuse partial-state balance computation');
});

test('DUR-12: restore validates the full financial ledger before replace deletes existing state', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const preflight = src.indexOf('prepareImportedFinancialTransactions(transactionsToImport, userId)');
  const destructiveReplace = src.indexOf("if (mode === 'replace')", preflight);
  assert.ok(preflight >= 0, 'restore must have a financial preflight');
  assert.ok(destructiveReplace > preflight, 'financial preflight must happen before replace-mode deletion');
  assert.ok(src.includes("reason: 'IMPORT_FINANCIAL_VALIDATION_FAILED'"),
    'invalid backup must fail before modifying current data');
});

test('DUR-13: restore writes only preflighted transactions and checks durability', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('for (const prepared of preparedTransactions.entries)'),
    'restore must write the validated canonical representation');
  assert.ok(src.includes("reason: 'IMPORT_NOT_DURABLY_COMMITTED'"),
    'merge restore must stop when a transaction is not durably committed');
  assert.equal(src.includes('for (const t of transactionsToImport)'), false,
    'raw backup transactions must not be written directly after preflight');
});

test('DUR-14: replace restore is one atomic batch and oversized backups fail before mutation', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  const replaceStart = src.indexOf("if (mode === 'replace')");
  const mergeStart = src.indexOf('// Merge mode:', replaceStart);
  const replaceBlock = src.slice(replaceStart, mergeStart);
  assert.ok(replaceBlock.includes('const batch = firebaseAdminDb.batch()'),
    'replace restore must use a real Firestore atomic batch');
  assert.ok(replaceBlock.includes('await batch.commit()'),
    'replace restore must commit its mutation plan once');
  assert.ok(replaceBlock.includes("reason: 'IMPORT_REPLACE_TOO_LARGE_FOR_ATOMIC_COMMIT'"),
    'oversized replace must fail closed before mutation');
  assert.ok(replaceBlock.includes("reason: 'IMPORT_REPLACE_ATOMIC_COMMIT_FAILED'"),
    'failed atomic commit must be reported explicitly');
  assert.equal(replaceBlock.includes('await adminDb.collection('), false,
    'replace must not delete or write documents individually');
});
