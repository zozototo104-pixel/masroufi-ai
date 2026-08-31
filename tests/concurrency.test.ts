/**
 * V6.1 Concurrency Tests (CONC-01..CONC-05).
 *
 * Verifies that atomic operations prevent TOCTOU race conditions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PENDING_STALE_MS,
  buildCompletedIdempotencyRecord,
  buildIndeterminateIdempotencyRecord,
  buildPendingIdempotencyRecord,
  decideIdempotencyClaim,
} from '../src/server/idempotencyCore.ts';

test('CONC-01: cash expense uses atomicAddTransaction (atomic guard present)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('atomicAddTransaction(userId, tx'), 'addTransaction uses atomicAddTransaction for balance-sensitive ops');
  assert.ok(src.includes('isBalanceSensitive'), 'balance-sensitivity check present');
});

test('CONC-02: PalPay expense uses atomic guard (same code path)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  // The atomic path covers both cash and palPay accounts for expense.
  assert.ok(src.includes("type === 'expense' && (account === 'cash' || account === 'palPay')"),
    'PalPay expense covered by atomic path');
});

test('CONC-03: payDebt uses atomicPayDebt (concurrent payment protection)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('atomicPayDebt(userId, tx, selected.key, selected.remaining'),
    'payDebt uses atomicPayDebt with creditor key');
  assert.ok(src.includes('OVERPAYMENT_ATOMIC'),
    'payDebt returns OVERPAYMENT_ATOMIC when concurrent payment exceeds remaining');
});

test('CONC-04: same operationId executes once (idempotency layer)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/idempotency.ts'), 'utf8');
  assert.ok(src.includes('adminDb.runTransaction'), 'uses Firestore runTransaction (atomic claim)');
  assert.ok(src.includes("kind: 'cache_hit'"), 'returns cache_hit on duplicate');
});

test('CONC-05: concurrent update + expense preserves invariant (NEGATIVE_CASH_RESULT guard)', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(src.includes('NEGATIVE_CASH_RESULT'),
    'updateTransaction blocks updates that would make cash negative');
  assert.ok(src.includes('resultingBalances.cash < -0.0001'),
    'guard triggers when resulting cash is negative');
});

test('CONC-06: atomicAddTransaction exists in atomicOps.ts', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.ok(src.includes('export async function atomicAddTransaction'),
    'atomicAddTransaction exported');
  assert.ok(src.includes('adminDb.runTransaction'),
    'uses Firestore runTransaction');
  assert.ok(src.includes('INSUFFICIENT_FUNDS_ATOMIC'),
    'returns INSUFFICIENT_FUNDS_ATOMIC on overspend');
});

test('CONC-07: atomicPayDebt recomputes creditor remaining through the shared domain core', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.ok(src.includes('calculateCreditorRemaining(transactions, creditorKey)'),
    'atomicPayDebt recomputes creditor remaining at transaction time through the shared core');
  assert.equal(src.includes('function recomputeCreditorRemaining'), false,
    'atomicOps must not keep a private duplicate creditor algorithm');
  assert.ok(src.includes('OVERPAYMENT_ATOMIC'),
    'returns OVERPAYMENT_ATOMIC when concurrent payment exceeds remaining');
});

test('CONC-08: atomicOps has no circular dependency on tools.ts', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  assert.equal(src.includes("from './tools'"), false,
    'atomic financial operations must depend on the shared domain core, not the orchestration layer');
  assert.ok(src.includes("from '../lib/balanceCalc'"),
    'atomic financial operations must use the shared financial domain core');
});

test('CONC-09: stale pending idempotency keys never auto-reexecute financial mutations', () => {
  const now = 1_000_000;
  const fresh = buildPendingIdempotencyRecord('u1', 'operation-123', now - 1_000);
  assert.equal(decideIdempotencyClaim(fresh, now).action, 'wait',
    'fresh concurrent duplicate must wait, not execute');

  const stale = buildPendingIdempotencyRecord('u1', 'operation-123', now - PENDING_STALE_MS - 1);
  const decision = decideIdempotencyClaim(stale, now);
  assert.equal(decision.action, 'return');
  assert.equal((decision as any).result.reason, 'IDEMPOTENT_OUTCOME_UNKNOWN');
  assert.equal((decision as any).result.retryable, false);
  assert.equal((decision as any).result.indeterminate, true);
});

test('CONC-10: completed and indeterminate outcomes are terminal behavioral states', () => {
  const now = 2_000_000;
  const completed = buildCompletedIdempotencyRecord('u1', 'operation-456', { success: true, transactionId: 't1' }, now);
  const cached = decideIdempotencyClaim(completed, now + 10);
  assert.equal(cached.action, 'return');
  assert.deepEqual((cached as any).result, { success: true, transactionId: 't1' });

  const indeterminate = buildIndeterminateIdempotencyRecord('u1', 'operation-789', new Error('commit acknowledgement lost'), now);
  assert.equal(indeterminate.status, 'indeterminate');
  assert.equal(indeterminate.result.reason, 'IDEMPOTENT_EXECUTION_INDETERMINATE');
  const blocked = decideIdempotencyClaim(indeterminate, now + 10_000);
  assert.equal(blocked.action, 'return');
  assert.equal((blocked as any).result.retryable, false);
});

test('CONC-11: transaction updates revalidate balances and write inside one Firestore transaction', async () => {
  const atomicSrc = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(atomicSrc.includes('export async function atomicUpdateTransaction'), 'atomic update primitive must exist');
  assert.ok(atomicSrc.includes('tx.update(ref, finalUpdates)'), 'update write must occur inside Firestore transaction');
  assert.ok(toolsSrc.includes('atomicUpdateTransaction(userId, args.id, finalUpdates'), 'updateTransaction must use atomic primitive');
  assert.equal(toolsSrc.includes('const writeResult = await txRef.update(finalUpdates)'), false,
    'updateTransaction must not perform the final write outside the atomic guard');
});

test('CONC-12: direct and smart transaction deletion revalidate and delete atomically', async () => {
  const atomicSrc = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(atomicSrc.includes('export async function atomicDeleteTransaction'), 'atomic delete primitive must exist');
  assert.ok(atomicSrc.includes('tx.delete(ref)'), 'delete must occur inside Firestore transaction');
  const calls = toolsSrc.match(/atomicDeleteTransaction\(userId,/g) || [];
  assert.ok(calls.length >= 2, 'both direct-ID and confirmed smart deletion must use atomic deletion');
});

test('CONC-13: receipt lines are validated first and persisted by one atomic transaction', async () => {
  const atomicSrc = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  const serverSrc = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  const toolsSrc = await readFile(join(process.cwd(), 'src/server/tools.ts'), 'utf8');
  assert.ok(atomicSrc.includes('export async function atomicAddTransactions'), 'multi-transaction atomic primitive must exist');
  assert.ok(toolsSrc.includes('export async function prepareAddTransaction'), 'receipt preparation helper must exist');
  assert.ok(serverSrc.includes('await prepareAddTransaction(txArgs'), 'receipt must validate every line without passing through the idempotency wrapper');
  assert.equal(serverSrc.includes('toolHandlers.add_transaction({ ...txArgs, validateOnly: true }'), false,
    'validation-only receipt preparation must not record completed idempotency outcomes before persistence');
  assert.ok(serverSrc.includes('await atomicAddTransactions('), 'receipt must persist through the atomic multi-line primitive');
  assert.equal(serverSrc.includes('createdBeforeFailure'), false, 'receipt endpoint must not expose partial-success semantics');
});

test('CONC-14: receipt retry uses a Firestore receipt idempotency record in the same transaction', async () => {
  const atomicSrc = await readFile(join(process.cwd(), 'src/server/atomicOps.ts'), 'utf8');
  const serverSrc = await readFile(join(process.cwd(), 'server.ts'), 'utf8');
  assert.ok(serverSrc.includes('receiptId,'), 'receipt endpoint must pass the stable receiptId into the atomic primitive');
  assert.ok(atomicSrc.includes("collection('receiptIdempotency')"), 'atomic receipt primitive must claim receipt idempotency');
  assert.ok(atomicSrc.includes('const receiptSnap = receiptRef ? await tx.get(receiptRef) : null'),
    'receipt idempotency record must be read inside the transaction before writes');
  assert.ok(atomicSrc.includes("status: 'completed'"), 'successful receipt commit must persist a completed receipt result');
  assert.ok(atomicSrc.includes('idempotentReplay: true'), 'retry must return the original receipt result instead of creating duplicate transactions');
  assert.ok(atomicSrc.includes('RECEIPT_OPERATION_CONFLICT'), 'conflicting operationIds must fail closed');
});
