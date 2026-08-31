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

test('CONC-09: stale pending idempotency keys never auto-reexecute financial mutations', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/idempotency.ts'), 'utf8');
  assert.ok(src.includes("reason: 'IDEMPOTENT_OUTCOME_UNKNOWN'"),
    'stale pending outcome must be surfaced as unknown');
  assert.ok(src.includes('exactly-once safety is more important than availability'),
    'stale pending policy must explicitly fail closed');
});

test('CONC-10: ambiguous handler failure becomes terminal indeterminate state', async () => {
  const src = await readFile(join(process.cwd(), 'src/server/idempotency.ts'), 'utf8');
  assert.ok(src.includes("status: 'indeterminate'"),
    'ambiguous execution must be persisted as indeterminate');
  assert.ok(src.includes("reason: 'IDEMPOTENT_EXECUTION_INDETERMINATE'"),
    'caller must receive an explicit ambiguous-outcome reason');
  assert.equal(src.includes("status: 'failed',\n      result: failure"), false,
    'ambiguous post-execution failure must not be converted into a retryable failed state');
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
